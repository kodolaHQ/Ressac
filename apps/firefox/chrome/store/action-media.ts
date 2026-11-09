// What an action's page shows besides its text: the result images, loaded anonymously in a container of their own,
// and the agent's components, served as sanitized resource:// copies (the widget displays' mechanism, plan 27) with
// the site home's parent.postMessage bridge (plan 31). Spike: docs/superpowers/notes/2026-11-06-actions-firefox-spike.md.
import { urlOuvrable } from "../../ui/accueil-profils";
import { CSP_WIDGET, displayServed } from "../window/widget-frame";
import { containerFor } from "./containers";
import { containerRequests, isLink, loadImage, realPath, toDataUrl } from "./site-home";

/** The kernel's COMPOSANT_HTML_MAX (pages/composants-agent.ts), copied: that module's node:fs imports have no shim in this bundle. Drift test in action-media.test.ts. */
export const COMPONENT_HTML_MAX = 256 * 1024;
/** The largest result image. */
export const ACTION_IMAGE_MAX = 5 * 1024 * 1024;

/** The result images' private container, `userContextIdInternal.webaios-action-images`: never a space's, a profile's or the default one. */
export const actionImagesContainer = (): number => containerFor("action-images");

/**
 * Tests only (WEBAIOS_TEST_ACTION_IMAGES = `origin`): `https://<host><path>` is fetched from `<origin>/<host><path>`.
 * The loader still judges the https address, so every redirect (reported with its real http URL) is refused.
 */
export function actionImageTestUrl(url: string, origin: string | undefined): string {
  if (!origin || !url.startsWith("https://")) return url;
  const u = new URL(url);
  return `${origin}/${u.host}${u.pathname}${u.search}`;
}

/** https only, never the machine. */
const allowed = (u: string) => u.startsWith("https://") && urlOuvrable(u);

/** A result image as a `data:` URL (no cookie, no referrer, checked redirects), or null. */
export async function actionImage(url: string): Promise<string | null> {
  const open = containerRequests(actionImagesContainer(), { anonymous: true });
  // Under the hook, an https redirect would be judged allowed and followed natively: test servers redirect to http.
  const origin = Services.env.get("WEBAIOS_TEST_ACTION_IMAGES") || undefined;
  const image = await loadImage((u, o) => open(actionImageTestUrl(u, origin), o), url, { permise: allowed, cookies: false, max: ACTION_IMAGE_MAX });
  return image && toDataUrl(image);
}

/**
 * The site home's bridge (homeBridge) for a component: `parent` becomes a frozen object whose postMessage dispatches
 * `webaios-composant` on the frame's window, its detail the message as JSON; `Components` is hidden. Self-contained, serialized with toString().
 */
export function componentBridge(): void {
  const w = window as unknown as Record<string, any>;
  const stringify = JSON.stringify;
  const Custom = w.CustomEvent;
  const dispatch = w.dispatchEvent.bind(w);
  w.parent = Object.freeze({ postMessage: (m: unknown) => void dispatch(new Custom("webaios-composant", { detail: stringify(m) })) });
  // Firefox's leftover web `Components` (`interfaces` only): hidden, a component page never sees it.
  Object.defineProperty(w, "Components", { value: undefined, configurable: false, writable: false });
}

export const COMPONENT_BRIDGE = `<script>(${componentBridge.toString()})();</script>`;

const NAME = /^[a-z0-9-]{1,40}$/;
const substitution = (name: string) => `webaios-composant-${name}`;
const copiesOf = (dataDir: string, name: string) => PathUtils.join(dataDir, "webaios-composants", name);

function substitute(name: string, dir: string | null): void {
  const handler = Services.io.getProtocolHandler("resource").QueryInterface(Ci.nsIResProtocolHandler);
  if (!dir) return handler.setSubstitution(substitution(name), null);
  const { FileUtils } = ChromeUtils.importESModule("resource://gre/modules/FileUtils.sys.mjs");
  handler.setSubstitution(substitution(name), Services.io.newFileURI(new FileUtils.File(dir)));
}

/** The pages showing each component, in every window. */
const refs = new Map<string, number>();
/** Serves and releases of each component, one at a time (a release reaching zero must not race a serve's publish). */
const queue = new Map<string, Promise<unknown>>();

function queued<T>(name: string, f: () => Promise<T>): Promise<T> {
  const run = (queue.get(name) ?? Promise.resolve()).then(f);
  const settled = run.catch(() => {});
  queue.set(name, settled);
  void settled.then(() => queue.get(name) === settled && queue.delete(name));
  return run;
}

/**
 * One more page shows component `nom`: copies `<dataDir>/espace/composants/<nom>/composant.html` with these rules
 * (no symbolic link on the path, COMPOSANT_HTML_MAX at most) into
 * `<dataDir>/webaios-composants/<nom>/composant-<mtime>.html` through affichageServi (the widgets' CSP and guard, then
 * the bridge; AFFICHAGE_REFUSE on a network hint), and returns its resource:// URL, or null. Each call is paired with a
 * releaseComponent, null or not.
 * shortcut: checked by realpath then read by path (IOUtils has no O_NOFOLLOW), as serveHome; upgrade with it.
 */
export function serveComponent(dataDir: string, name: string): Promise<string | null> {
  if (typeof name !== "string" || !NAME.test(name)) return Promise.resolve(null);
  refs.set(name, (refs.get(name) ?? 0) + 1);
  return queued(name, async () => {
    try {
      const components = PathUtils.join(dataDir, "espace", "composants");
      const componentsReal = realPath(components);
      // An exact name: a case-insensitive disk would find « Barres » for « barres ».
      if (!componentsReal || isLink(components) || !(await IOUtils.getChildren(components)).some((c) => c.endsWith(`/${name}`))) return null;
      const source = PathUtils.join(components, name, "composant.html");
      if (realPath(source) !== PathUtils.join(componentsReal, name, "composant.html")) return null;
      const info = await IOUtils.stat(source);
      if (info.type !== "regular" || info.size > COMPONENT_HTML_MAX) return null;
      const bytes = await IOUtils.read(source, { maxBytes: COMPONENT_HTML_MAX + 1 });
      if (bytes.length > COMPONENT_HTML_MAX) return null;
      const copies = copiesOf(dataDir, name);
      await IOUtils.makeDirectory(copies, { createAncestors: true, ignoreExisting: true });
      // The copies stay inside <dataDir>/webaios-composants: a copies folder that is a link is refused.
      const root = realPath(PathUtils.join(dataDir, "webaios-composants"));
      if (!root || realPath(copies) !== PathUtils.join(root, name)) return null;
      const file = `composant-${Math.round(info.lastModified)}.html`;
      const copy = PathUtils.join(copies, file);
      if (!(await IOUtils.exists(copy))) {
        // Atomic: a frame never reads a half-written copy.
        const tmp = `${copy}.${crypto.randomUUID()}.tmp`;
        await IOUtils.writeUTF8(tmp, displayServed(new TextDecoder().decode(bytes), CSP_WIDGET, COMPONENT_BRIDGE));
        await IOUtils.move(tmp, copy);
      }
      // One copy per name: a frame still showing an older one has it loaded already.
      for (const old of await IOUtils.getChildren(copies)) if (old !== copy) await IOUtils.remove(old, { ignoreAbsent: true });
      substitute(name, copies);
      return `resource://${substitution(name)}/${file}`;
    } catch (e) {
      console.error(`[actions] composant ${name} non servi :`, e);
      return null;
    }
  });
}

/** One page less shows component `nom`: at zero, its substitution and its copies go. */
export function releaseComponent(dataDir: string, name: string): Promise<void> {
  const n = refs.get(name);
  if (!n) return Promise.resolve();
  if (n > 1) {
    refs.set(name, n - 1);
    return Promise.resolve();
  }
  refs.delete(name);
  return queued(name, async () => {
    // A serve queued meanwhile counted again: it keeps its copy.
    if (refs.has(name)) return;
    substitute(name, null);
    await IOUtils.remove(copiesOf(dataDir, name), { recursive: true, ignoreAbsent: true });
  });
}
