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

/** The store registers the RessacFrame actor and says where its module is: the onFrameMessage registry lives there. */
export function setFrameActor(uri: string): void {
  actor = uri;
}

/** A frame <browser> for `doc`, not inserted yet: the caller appends it, then calls loadFrame. */
export function createFrameBrowser(doc: Document): Element {
  const b = (doc as any).createXULElement("browser") as Element;
  // No maychangeremoteness: the frame stays in its webIsolated process whatever it navigates to.
  const attrs = { type: "content", remote: "true", remoteType: `webIsolated=${framesOrigin()}`, messagemanagergroup: FRAMES_GROUP };
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

/** The frame's messages (frame-actor.ts: loaded, press, focus, open, home, component); returns how to stop. */
export function onFrameMessage(browser: Element, cb: (name: string, data: any) => void): () => void {
  return ChromeUtils.importESModule(actor).onFrameMessage(browser, cb);
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
