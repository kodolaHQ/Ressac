// The agent-written frames as remote <browser>s in one web content process (spec 2026-11-20-cadres-hors-processus).
// Bundled in the store only (exported as `remoteFrames`): the group id and the actor's registry are one per launch, so
// every window's UI reaches this copy through the store (ui/RemoteFrame.svelte).
import { ensureFramesSubstitution, FRAMES_GROUP, framesOrigin } from "./frames-root";

const STORE = "chrome://browser/content/ressac/store.sys.mjs";
/** `browsingContext.sandboxFlags` of an `<iframe sandbox="allow-scripts">` (measured, Firefox 160): opaque origin, no forms, popups, top navigation, storage… */
export const SANDBOX_ALLOW_SCRIPTS = 1048191;

let actor = "";
/** The group every frame browser joins; Firefox makes it again under the same id if its last browser went. */
let groupId: number | null = null;

/** Frames mounted before setFrameActor (the home's widgets at startup): subscribed once it runs. */
const waiting = new Set<() => void>();

/** The store registers the RessacFrame actor and says where its module is: the onFrameMessage registry lives there. */
export function setFrameActor(uri: string): void {
  actor = uri;
  for (const start of [...waiting]) start();
  waiting.clear();
}

/** A frame <browser> for `doc`, not inserted yet: the caller appends it, then calls loadFrame. */
export function createFrameBrowser(doc: Document): Element {
  const b = (doc as any).createXULElement("browser") as Element;
  // No maychangeremoteness: the frame stays in its webIsolated process whatever it navigates to.
  // `transparent`: else the remote page paints an opaque canvas over what is behind it (BrowserParent reads it once).
  const attrs = { type: "content", remote: "true", remoteType: `webIsolated=${framesOrigin()}`, messagemanagergroup: FRAMES_GROUP, transparent: "true" };
  for (const [k, v] of Object.entries(attrs)) b.setAttribute(k, v);
  if (groupId !== null) b.setAttribute("initialBrowsingContextGroupId", String(groupId));
  return b;
}

/**
 * Loads `src` in an inserted frame browser: sandboxed first, with the system as triggering principal. False, and
 * nothing loaded, when the UI's network guard is missing (as cutFrameNetwork) or the browser has no context.
 */
export function loadFrame(browser: Element, src: string): boolean {
  const bc = (browser as any).browsingContext;
  if (!bc) return false;
  if (!(browser as any).webNavigation) {
    // Inserted before its document's DOMContentLoaded has been dispatched (customElements.js connects the delayed
    // <browser>s during that dispatch, so "interactive" still waits): it constructs before this later listener runs.
    if (browser.ownerDocument.readyState === "complete") {
      console.error("[frames] the frame browser has no web navigation in a loaded document: nothing loads");
      return false;
    }
    (browser.ownerDocument as any).defaultView.addEventListener("DOMContentLoaded", () => browser.isConnected && loadFrame(browser, src), { once: true });
    return true;
  }
  if (!ChromeUtils.importESModule(STORE).uiNetwork.state()?.observer) {
    console.error("[ui-network] the UI's network guard is missing: frames stay empty");
    return false;
  }
  bc.sandboxFlags = SANDBOX_ALLOW_SCRIPTS;
  groupId ??= bc.group.id;
  ensureFramesSubstitution();
  (browser as any).loadURI(Services.io.newURI(src), { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
  return true;
}

const REVERT_FLOOR_MS = 1000;

/**
 * An owner's « left its copy → load it again », bounded: a copy that never comes (a missing file gives a neterror
 * page) or a page that keeps leaving would else reload in a loop in the process every frame shares. One revert per
 * address until a load the owner keeps, at least REVERT_FLOOR_MS apart. The first one is what really loads a new
 * frame (its initial about:blank report, README). One per browser: its owner and the home's guard (sites.ts) share it.
 */
type Reverter = { loaded(run: () => void): void; revert(src: string): void };
const reverters = new WeakMap<Element, Reverter>();
export function frameReverter(browser: Element): Reverter {
  let r = reverters.get(browser);
  if (!r) reverters.set(browser, (r = makeReverter(browser)));
  return r;
}

function makeReverter(browser: Element): Reverter {
  let tried: string | null = null;
  let asked = false;
  let last = -Infinity;
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    /** Runs the owner's `loaded` handler: a load during which it asked no revert is kept. */
    loaded(run) {
      asked = false;
      run();
      if (asked) return;
      tried = null;
      clearTimeout(timer);
    },
    revert(src) {
      asked = true;
      if (tried === src) return;
      tried = src;
      clearTimeout(timer);
      const go = () => {
        last = Date.now();
        if (browser.isConnected) loadFrame(browser, src);
      };
      const wait = last + REVERT_FLOOR_MS - Date.now();
      if (wait > 0) timer = setTimeout(go, wait);
      else go();
    },
  };
}

/** The frame's messages (frame-actor.ts: loaded, press, focus, open, home, component); returns how to stop. */
export function onFrameMessage(browser: Element, cb: (name: string, data: any) => void): () => void {
  const subscribe = () => ChromeUtils.importESModule(actor).onFrameMessage(browser, cb) as () => void;
  if (actor) return subscribe();
  // Before the store registered the actor (it does so after awaits): nothing can arrive yet, subscribed when it does.
  let off: (() => void) | null = null;
  const start = () => (off = subscribe());
  waiting.add(start);
  return () => {
    waiting.delete(start);
    off?.();
  };
}

/** Posts `data` into the frame's page; a frame gone or between documents drops it. */
export async function sendFrame(browser: Element, data: unknown): Promise<void> {
  try {
    await (browser as any).browsingContext?.currentWindowGlobal?.getActor("RessacFrame").sendQuery("send", { data });
  } catch {
    // Removed, navigating or crashed: the next load sends again.
  }
}

/** The frame's current document address, or null. */
export function frameUri(browser: Element): string | null {
  try {
    return (browser as any).browsingContext?.currentWindowGlobal?.documentURI?.spec ?? null;
  } catch {
    return null;
  }
}
