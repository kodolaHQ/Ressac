// A call's video floats when its tab is left, and goes back when the tab is shown again: Firefox's own automatic
// picture-in-picture (enable-when-switching-tabs), kept for calls only. Firefox would take any long video with sound
// and refuses a call's (a live stream, no sound track of its own): the tab's call actor chooses instead.

const PREF = "media.videocontrols.picture-in-picture.enable-when-switching-tabs.enabled";

export function installCallPlayer(): void {
  Services.prefs.getDefaultBranch("").setBoolPref(PREF, true);
  const { PictureInPictureToggleParent, PictureInPicture } = ChromeUtils.importESModule("moz-src:///toolkit/components/pictureinpicture/PictureInPicture.sys.mjs") as any;
  const receive = PictureInPictureToggleParent.prototype.receiveMessage;
  PictureInPictureToggleParent.prototype.receiveMessage = function (this: unknown, msg: any) {
    if (msg.name !== "PictureInPicture:VideoTabHidden") return receive.call(this, msg);
    const context = msg.target.browsingContext;
    const browser = context.top.embedderElement;
    // A tab switch only: a hidden window keeps its videos where they are.
    if (!browser || browser.ownerDocument?.defaultView?.gBrowser?.selectedBrowser === browser) return undefined;
    // As Firefox: a player the user closed does not come back until the tab was shown again.
    if (PictureInPicture.weakAutoPipBrowserClosedDeliberately.has(browser)) return void PictureInPicture.weakAutoPipBrowserClosedDeliberately.delete(browser);
    try {
      context.currentWindowGlobal?.getActor("RessacCall").sendAsyncMessage("call:leave");
    } catch {
      // No call actor in this frame (not http(s)): nothing floats.
    }
    return undefined;
  };
}
