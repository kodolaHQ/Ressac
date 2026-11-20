// What an action's page shows besides its text: the result images, loaded anonymously in a container of their own,
// and the agent's components, served as sanitized resource:// copies (the widget displays' mechanism, plan 27) with
// the site home's parent.postMessage bridge (plan 31). Probed by e2e/actions-spike.e2e.ts.
import { openableUrl } from "../../ui/home-profiles";
import { CSP_WIDGET, displayServed } from "../window/widget-frame";
import { ensureFramesSubstitution, framesKindDir, framesOrigin } from "../window/frames-root";
import { containerFor } from "./containers";
import { containerRequests, isLink, loadImage, realPath, toDataUrl } from "./site-home";
import THEME from "../../ui/theme.css?raw";
import { testEnv } from "../test-env";

/** The kernel's COMPONENT_HTML_MAX (pages/agent-components.ts), copied: that module's node:fs imports have no shim in this bundle. Drift test in action-media.test.ts. */
export const COMPONENT_HTML_MAX = 256 * 1024;
/** The largest result image. */
export const ACTION_IMAGE_MAX = 5 * 1024 * 1024;

/** The result images' private container, `userContextIdInternal.webaios-action-images`: never a space's, a profile's or the default one. */
export const actionImagesContainer = (): number => containerFor("action-images");

/**
 * Tests only (RESSAC_TEST_ACTION_IMAGES = `origin`): `https://<host><path>` is fetched from `<origin>/<host><path>`.
 * The loader still judges the https address, so every redirect (reported with its real http URL) is refused.
 */
export function actionImageTestUrl(url: string, origin: string | undefined): string {
  if (!origin || !url.startsWith("https://")) return url;
  const u = new URL(url);
  return `${origin}/${u.host}${u.pathname}${u.search}`;
}

/** https only, never the machine. */
const allowed = (u: string) => u.startsWith("https://") && openableUrl(u);

/** A result image as a `data:` URL (no cookie, no referrer, checked redirects), or null. */
export async function actionImage(url: string): Promise<string | null> {
  const open = containerRequests(actionImagesContainer(), { anonymous: true });
  // Under the hook, an https redirect would be judged allowed and followed natively: test servers redirect to http.
  const origin = testEnv("RESSAC_TEST_ACTION_IMAGES") || undefined;
  const image = await loadImage((u, o) => open(actionImageTestUrl(u, origin), o), url, { allowed: allowed, cookies: false, max: ACTION_IMAGE_MAX });
  return image && toDataUrl(image);
}

/**
 * The site home's bridge (homeBridge) for a component: `parent` becomes a frozen object whose postMessage dispatches
 * `ressac-component` on the frame's window, its detail the message as JSON; the Aura tokens of the chrome's messages
 * are set on the root; `Components` is hidden. Self-contained, serialized with toString().
 */
export function componentBridge(): void {
  const w = window as unknown as Record<string, any>;
  const stringify = JSON.stringify;
  const Custom = w.CustomEvent;
  const dispatch = w.dispatchEvent.bind(w);
  w.parent = Object.freeze({ postMessage: (m: unknown) => void dispatch(new Custom("ressac-component", { detail: stringify(m) })) });
  // The Aura tokens of each component message become CSS variables on the root, before the component's own listener runs.
  const root = w.document.documentElement;
  w.addEventListener("message", (e: MessageEvent) => {
    const t = e.data?.type === "component" ? e.data.tokens : null;
    if (t && typeof t === "object") for (const k of Object.keys(t)) if (/^--[a-z0-9-]+$/.test(k) && typeof t[k] === "string") root.style.setProperty(k, t[k]);
  });
  // Firefox's leftover web `Components` (`interfaces` only): hidden, a component page never sees it.
  Object.defineProperty(w, "Components", { value: undefined, configurable: false, writable: false });
}

export const COMPONENT_BRIDGE = `<script>(${componentBridge.toString()})();</script>`;

/** The browser's @font-face rules (theme.css), their chrome:// sources inlined as data: (the CSP allows font-src data: only). */
let fonts: Promise<string> | null = null;
export function componentFonts(): Promise<string> {
  fonts ??= Promise.all(
    (THEME.match(/@font-face\s*{[^}]*}/g) ?? []).map(async (rule) => {
      const url = rule.match(/url\("(chrome:[^"]+)"\)/)?.[1];
      if (!url) return "";
      const body = new Uint8Array(await (await fetch(url)).arrayBuffer());
      return rule.replace(url, toDataUrl({ type: "font/woff2", body }));
    }),
  ).then(
    (rules) => `<style>${rules.join("")}</style>`,
    (e) => {
      console.warn("[actions] component fonts not inlined:", e);
      fonts = null; // tried again with the next copy
      return "";
    },
  );
  return fonts;
}

const NAME = /^[a-z0-9-]{1,40}$/;
const copiesOf = (name: string) => PathUtils.join(framesKindDir("components"), name);

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

/** The host's `actions.copyComponent`: the component page's mtime once copied as `source-<token>.html`, or null. */
export type ComponentCopy = (name: string, token: string) => Promise<number | null>;

/**
 * One more page shows component `nom`: the host copies `<dataDir>/workspace/components/<nom>/component.html` (never
 * through a link, COMPONENT_HTML_MAX at most) into `<framesDir>/components/<nom>/`, served from there as
 * `component-<mtime>.html` through displayServed (the widgets' CSP and guard, then the bridge and the browser fonts;
 * displayDenied() on a network hint), and returns its resource:// URL, or null. Each call is paired with a
 * releaseComponent, null or not.
 */
export function serveComponent(dataDir: string, name: string, copy: ComponentCopy): Promise<string | null> {
  if (typeof name !== "string" || !NAME.test(name)) return Promise.resolve(null);
  refs.set(name, (refs.get(name) ?? 0) + 1);
  return queued(name, async () => {
    try {
      const components = PathUtils.join(dataDir, "workspace", "components");
      // An exact name: a case-insensitive disk would find « Barres » for « barres ». A quick refusal; the host's copy is swap-proof.
      if (!realPath(components) || isLink(components) || !(await IOUtils.getChildren(components)).some((c) => c.endsWith(`/${name}`))) return null;
      const copies = copiesOf(name);
      await IOUtils.makeDirectory(copies, { createAncestors: true, ignoreExisting: true });
      // The copies stay inside <framesDir>/components: a copies folder that is a link is refused.
      const root = realPath(framesKindDir("components"));
      if (!root || realPath(copies) !== PathUtils.join(root, name)) return null;
      const token = crypto.randomUUID().replace(/-/g, "");
      const mtime = await copy(name, token);
      if (mtime === null) return null;
      const bytes = await IOUtils.read(PathUtils.join(copies, `source-${token}.html`));
      // Keyed on mtime and size: a rewrite that keeps the old mtime (cp -p, touch -r, a tar) still makes a new copy.
      const file = `component-${Math.round(mtime)}-${bytes.length}.html`;
      const target = PathUtils.join(copies, file);
      if (!(await IOUtils.exists(target))) {
        // Atomic: a frame never reads a half-written copy.
        const tmp = `${target}.${crypto.randomUUID()}.tmp`;
        await IOUtils.writeUTF8(tmp, displayServed(new TextDecoder().decode(bytes), CSP_WIDGET, COMPONENT_BRIDGE + (await componentFonts())));
        await IOUtils.move(tmp, target);
      }
      // One copy per name (the source copy goes too): a frame still showing an older one has it loaded already.
      for (const old of await IOUtils.getChildren(copies)) if (old !== target) await IOUtils.remove(old, { ignoreAbsent: true });
      ensureFramesSubstitution();
      return `${framesOrigin()}/components/${name}/${file}`;
    } catch (e) {
      console.error(`[actions] component ${name} not served:`, e);
      return null;
    }
  });
}

/** One page less shows component `nom`: at zero, its substitution and its copies go. */
export function releaseComponent(_dataDir: string, name: string): Promise<void> {
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
    await IOUtils.remove(copiesOf(name), { recursive: true, ignoreAbsent: true });
  });
}
