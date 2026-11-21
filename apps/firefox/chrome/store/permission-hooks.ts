import type { WindowId, TabId, ProfileId } from "../../shared/model";
import type { SitePermissions, SiteRequest } from "./site-permissions";
import { FRAMES_GROUP } from "../window/frames-root";

const { Integration } = ChromeUtils.importESModule("resource://gre/modules/Integration.sys.mjs");

/** Firefox's content permission types we ask about, as the kinds of SitePermissions.handle. Any other: refused, no question. */
const KINDS: Record<string, string> = {
  "desktop-notification": "notifications",
  geolocation: "geolocation",
  // media.eme.require-app-approval: one request per document (spike P4). MIDI SysEx is the same question (P1).
  "media-key-system-access": "drm",
  midi: "midi",
};

/** Calls `cb` once the browser's page goes (top-level navigation) or its window closes: Firefox tells a held request nothing (spike P1). */
function watchGone(browser: any, cb: () => void): () => void {
  const listener = {
    onLocationChange(progress: any, _request: unknown, _location: unknown, flags: number) {
      if (progress.isTopLevel && !(flags & Ci.nsIWebProgressListener.LOCATION_CHANGE_SAME_DOCUMENT)) cb();
    },
    QueryInterface: ChromeUtils.generateQI(["nsIWebProgressListener", "nsISupportsWeakReference"]),
  };
  const win = browser.ownerDocument.defaultView;
  browser.addProgressListener(listener, Ci.nsIWebProgress.NOTIFY_LOCATION);
  win.addEventListener("unload", cb);
  return () => {
    // The browser may be gone already (its tab closed).
    try {
      browser.removeProgressListener(listener);
    } catch {}
    win.removeEventListener("unload", cb);
  };
}

/**
 * Site permission requests go to our banner instead of Firefox's prompts (spike P1): one registration for the whole
 * process, windows and invisible reads alike. Returns what unregisters it.
 */
export function registerPermissionHooks(o: {
  sitePermissions: SitePermissions;
  /** The Ressac tab behind a browser (a popup's: its opener's tab), or null. */
  tabOf(browser: any): { tabId: TabId; windowId: WindowId; profile: ProfileId } | null;
  isInvisible(browser: any): boolean;
}): () => void {
  /**
   * Asks the banner about `request` on `browser` and answers through `respond`. No question for an invisible read, a
   * browser without a tab, or an opaque or unreadable origin (file:, data:, the system principal…).
   * Returns what withdraws the question.
   */
  const ask = (browser: any, principal: any, request: Pick<SiteRequest, "kind" | "mediaTypes" | "link">, respond: (ok: boolean) => void) => {
    const gone = new AbortController();
    const tab = browser && !o.isInvisible(browser) ? o.tabOf(browser) : null;
    let origin = "null";
    try {
      origin = new URL(principal.originNoSuffix).origin;
    } catch {}
    if (!tab || origin === "null") return respond(false), gone;
    const unwatch = watchGone(browser, () => gone.abort());
    o.sitePermissions
      .handle({ ...tab, origin: origin, ...request, signal: gone.signal })
      .then(respond, () => respond(false))
      .finally(unwatch);
    return gone;
  };
  const decide = (type: string, request: any) => {
    // After a tab closes, the request throws on any use.
    const respond = (ok: boolean) => {
      try {
        if (ok) request.allow();
        else request.cancel();
      } catch {}
    };
    const kind = KINDS[type];
    if (!kind) return respond(false);
    ask(request.element, request.principal, { kind }, respond);
  };
  const factory = (base: object) => ({
    __proto__: base,
    createPermissionPrompt: (type: string, request: any) => ({ prompt: () => decide(type, request) }),
  });
  Integration.contentPermission.register(factory);

  // Camera, microphone and screen: Firefox's own prompt (WebRTCParent) never shows (spike P2, P3). Its code, kept to answer the same way.
  const { WebRTCParent } = ChromeUtils.importESModule("resource:///actors/WebRTCParent.sys.mjs");
  const receive = WebRTCParent.prototype.receiveMessage;
  const calls = new Map<string, AbortController>();
  WebRTCParent.prototype.receiveMessage = function (this: any, msg: any) {
    if (msg.name === "webrtc:CancelRequest") calls.get(msg.data)?.abort();
    if (msg.name !== "webrtc:Request") return receive.call(this, msg);
    const d = msg.data;
    const screen = !!d.sharingScreen;
    // The frame that asks, not the top-level page (spike P2).
    const frame = this.manager.documentPrincipal;
    let answered = false;
    const respond = (ok: boolean) => {
      answered = true;
      calls.delete(d.callID);
      try {
        // Screen: the one device that opens macOS's own picker (branch 1 of the notes); none = refused.
        const video = screen ? d.videoInputDevices.find((x: any) => x.canRequestOsLevelPrompt) : d.videoInputDevices[0];
        if (!ok || (screen && !video)) return this.denyRequest(d);
        const devices = [video?.deviceIndex, d.audioInputDevices[0]?.deviceIndex].filter((x) => x !== undefined);
        // As Firefox's own allow: the one-shot camera grant, then macOS's check for a real device.
        // The screen too: CamerasParent checks this grant for every capture engine.
        if (video) Services.perms.addFromPrincipal(this.manager.topWindowContext.documentPrincipal, "MediaManagerVideo", Services.perms.ALLOW_ACTION, Services.perms.EXPIRE_SESSION);
        this.checkOSPermission(!screen && !!video, d.audioInputDevices.length > 0, screen).then(
          (granted: boolean) => (granted ? this.sendAsyncMessage("webrtc:Allow", { callID: d.callID, windowID: d.windowID, devices }) : this.denyRequestNoPermission(d)),
          () => {},
        );
      } catch {}
    };
    const mediaTypes = [...(d.videoInputDevices.length && !screen ? ["video"] : []), ...(d.audioInputDevices.length ? ["audio"] : [])];
    const cancel = ask(this.browsingContext.top.embedderElement, frame, screen ? { kind: "screen-share" } : { kind: "media", mediaTypes }, respond);
    // Refused at once (no tab of ours…): nothing left to cancel.
    if (!answered) calls.set(d.callID, cancel);
  };

  // A link to another application: Firefox's own dialog never shows (spike P5).
  const { nsContentDispatchChooser } = ChromeUtils.importESModule("resource://gre/modules/ContentDispatchChooser.sys.mjs");
  const handleURI = nsContentDispatchChooser.prototype.handleURI;
  let frameRefusalLogged = false;
  nsContentDispatchChooser.prototype.handleURI = function (handler: any, uri: any, principal: any, bc: any) {
    // An agent-written frame (remote-frame.ts) never opens another application, whatever its principal says: its
    // sandbox blocks this only for nested frames, and frames are top-level contexts of their own browser.
    if (bc?.top?.embedderElement?.getAttribute?.("messagemanagergroup") === FRAMES_GROUP) {
      if (!frameRefusalLogged) console.error("[frames] refused a link to another application from a frame");
      frameRefusalLogged = true;
      return;
    }
    // Typed in the address bar (no principal, or the system one): asked in the name of the site the tab shows.
    if (!principal || principal.isSystemPrincipal) principal = bc?.top?.currentWindowGlobal?.documentPrincipal;
    if (principal)
      ask(bc?.top?.embedderElement, principal, { kind: "openExternal", link: uri.spec }, (ok) => {
        if (!ok) return;
        // A macOS application with no chosen one: its default (nothing is stored).
        if (handler.hasDefaultHandler && !handler.preferredApplicationHandler) handler.preferredAction = Ci.nsIHandlerInfo.useSystemDefault;
        handler.launchWithURI(uri, bc);
      });
  };

  // Reading the clipboard: refused without a question, never Firefox's « Coller » menu (spike P8).
  const { ClipboardContextMenu } = ChromeUtils.importESModule("resource://gre/modules/ClipboardContextMenu.sys.mjs");
  const { PromptUtils } = ChromeUtils.importESModule("resource://gre/modules/PromptUtils.sys.mjs");
  const confirmUserPaste = ClipboardContextMenu.confirmUserPaste;
  ClipboardContextMenu.confirmUserPaste = () => Promise.resolve(PromptUtils.objectToPropBag({ ok: false }));

  return () => {
    Integration.contentPermission.unregister(factory);
    ClipboardContextMenu.confirmUserPaste = confirmUserPaste;
    WebRTCParent.prototype.receiveMessage = receive;
    nsContentDispatchChooser.prototype.handleURI = handleURI;
  };
}
