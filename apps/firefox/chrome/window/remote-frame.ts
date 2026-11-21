// The agent-written frames as remote <browser>s in one web content process (spec 2026-11-20-cadres-hors-processus).
// Bundled in the store only (exported as `remoteFrames`): the group id and the actor's registry are one per launch, so
// every window's UI reaches this copy through the store (ui/RemoteFrame.svelte).
import { ensureFramesSubstitution, FRAMES_GROUP, framesOrigin } from "./frames-root";

const STORE = "chrome://browser/content/ressac/store.sys.mjs";
/** `browsingContext.sandboxFlags` of an `<iframe sandbox="allow-scripts">` (measured, Firefox 160): opaque origin, no forms, popups, top navigation, storage… */
export const SANDBOX_ALLOW_SCRIPTS = 1048191;

let actor = "";
/** The group every frame browser joins; a new one once they all went (forgetDeadGroup) or after a crash (revive). */
let groupId: number | null = null;

/** Frames mounted before setFrameActor (the home's widgets at startup): subscribed once it runs. */
const waiting = new Set<() => void>();

/** The store registers the RessacFrame actor and says where its module is: the onFrameMessage registry lives there. */
export function setFrameActor(uri: string): void {
  actor = uri;
  for (const start of [...waiting]) start();
  waiting.clear();
}

/**
 * A frame <browser> for `doc`, not inserted yet: the caller appends it, then calls loadFrame. `onCrash` runs when its
 * process died: `true` once it is a new browsing context loading its copy again, `false` when it stays empty.
 */
export function createFrameBrowser(doc: Document, onCrash?: (revived: boolean) => void): Element {
  const b = (doc as any).createXULElement("browser") as Element;
  setFrameAttributes(b);
  b.addEventListener("oop-browser-crashed", (e) => revive(b, e, onCrash));
  return b;
}

/** Every frame browser made, in any window; dropped once seen out of its document (an owner unmounted it). */
const frameBrowsers = new Set<Element>();

/**
 * The group id is reused only while one of our frames is still in the page. Once every frame went (the home hidden by a
 * tab), its group dies, and Firefox's late teardown of it (its last reference released at a GC) removes from its table
 * whatever group holds that id by then: a new group made under the same id loses its entry, and the next frame gets
 * a group of its own, so a second process (measured: one forced GC after the home came back is enough).
 */
function forgetDeadGroup(b: Element): void {
  for (const f of frameBrowsers) if (f !== b && !f.isConnected) frameBrowsers.delete(f);
  if (![...frameBrowsers].some((f) => f !== b)) groupId = null;
  frameBrowsers.add(b);
}

/** Before each insertion: Firefox drops `remoteType` once the remote browser is up, and without it a new one goes to a shared web process. */
function setFrameAttributes(b: Element): void {
  forgetDeadGroup(b);
  // No maychangeremoteness: the frame stays in its webIsolated process whatever it navigates to.
  // `transparent`: else the remote page paints an opaque canvas over what is behind it (BrowserParent reads it once).
  // `disablefullscreen`: a XUL browser allows fullscreen to its page otherwise (BrowsingContext::FullscreenAllowed).
  const attrs = { type: "content", remote: "true", remoteType: `webIsolated=${framesOrigin()}`, messagemanagergroup: FRAMES_GROUP, transparent: "true", disablefullscreen: "true" };
  for (const [k, v] of Object.entries(attrs)) b.setAttribute(k, v);
  if (groupId !== null) b.setAttribute("initialBrowsingContextGroupId", String(groupId));
  else b.removeAttribute("initialBrowsingContextGroupId");
}

/** Revivals a frame gets in a minute; past them it stays empty, so a page that kills its process cannot loop it. */
export const REVIVES_PER_MINUTE = 3;
/** The address each frame browser last loaded: what a revival loads again. */
const sources = new WeakMap<Element, string>();
const revivals = new WeakMap<Element, number[]>();
/** The crashes already logged, by child id: every frame of the process gets the event. */
const loggedCrashes = new Set<number>();

/**
 * The frames' process died (a crash, memory exhausted): every frame browser gets this event. A dead remote browser
 * without maychangeremoteness cannot load again, so it is taken out and put back (a new frame loader and browsing
 * context, same element), then loads its last address; the owner's `loaded` and reverter feed it again.
 */
function revive(b: Element, e: any, onCrash?: (revived: boolean) => void): void {
  if (!e.isTrusted || !e.isTopFrame || e.target !== b) return;
  // Ours alone: never Firefox's tab crash page, nor a tab's handler (chrome/window/tabs.ts).
  e.stopPropagation();
  const now = Date.now();
  const recent = (revivals.get(b) ?? []).filter((t) => now - t < 60_000);
  const src = sources.get(b);
  const again = recent.length < REVIVES_PER_MINUTE;
  if (!loggedCrashes.has(e.childID)) {
    loggedCrashes.add(e.childID);
    // A new group for the revived frames: the dead one may linger with its dead host, and frames joining it while it
    // does each pick a process of their own (dom.ipc.processCount.webIsolated is 4; measured: two processes).
    groupId = null;
    console.error(`[frames] the frames' process stopped: ${again ? "frames load again" : "frames left empty"}`);
  }
  if (!again) return onCrash?.(false);
  revivals.set(b, [...recent, now]);
  // After the event: the frame loader is still being torn down while it is dispatched.
  setTimeout(() => {
    const parent = b.parentNode;
    if (!parent || !b.isConnected) return;
    const next = b.nextSibling;
    b.remove();
    setFrameAttributes(b);
    parent.insertBefore(b, next);
    // The first revived frame makes the new group, the next ones join it (their timeouts run after this one).
    groupId ??= (b as any).browsingContext?.group?.id ?? null;
    onCrash?.(true);
    // No address yet (it crashed before its first load): its owner's first loadFrame or revert loads it.
    if (src) loadFrame(b, src);
  });
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
  sources.set(browser, src);
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

let unsandboxedLogged = false;
/**
 * The frame's current document has a null principal (opaque origin) and runs in the frames' process. Both are set
 * indirectly: SANDBOX_ALLOW_SCRIPTS follows Firefox's flag numbering, the process its `remoteType` attribute. Should
 * either drift, the frame is sent nothing and is not its owner's (RemoteFrame): it fails closed, logged once. The
 * initial about:blank is not ours anyway: not logged.
 */
export function frameSandboxed(browser: Element): boolean {
  let wg: any = null;
  try {
    wg = (browser as any).browsingContext?.currentWindowGlobal;
  } catch {}
  if (!wg) return false;
  if (wg.documentPrincipal?.isNullPrincipal && wg.domProcess?.remoteType === `webIsolated=${framesOrigin()}`) return true;
  if (!unsandboxedLogged && wg.documentURI?.spec !== "about:blank") {
    unsandboxedLogged = true;
    console.error("[frames] a frame's document is not sandboxed (a null principal in the frames' process): it is sent nothing");
  }
  return false;
}

/** Posts `data` into the frame's page; a frame gone, between documents or not sandboxed drops it. */
export async function sendFrame(browser: Element, data: unknown): Promise<void> {
  if (!frameSandboxed(browser)) return;
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
