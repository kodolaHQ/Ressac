// The calls' actor: in a tab that uses the camera or the microphone, it hands the call's video to Firefox's
// picture-in-picture when the tab is left (chrome/store/call-player.ts), tells the call's state and works its
// microphone and camera for the sidebar's call bar (chrome/window/calls.ts). The child acts only on the parent's demand; the parent only relays a state.
// Packaged: a change here needs build:ui.

import { CALL_SITES, type CallKey, type CallSite, type CallState } from "../../shared/call-sites";

const { setInterval, clearInterval } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");

/** How often the watched state is read again (ms): the site's buttons and the capture change without an event of ours. */
const WATCH_MS = 500;
const CAPTURE_ENABLED = 1;

export class WebAiOsCallParent extends JSWindowActorParent {
  receiveMessage(msg: { name: string; data: unknown }): void {
    // The tab's browser by its id: its window finds its own (chrome/window/calls.ts).
    if (msg.name === "call:state") Services.obs.notifyObservers(null, "webaios-call-state", JSON.stringify({ browserId: this.browsingContext.top.browserId, call: msg.data }));
  }
}

export class WebAiOsCallChild extends JSWindowActorChild {
  private watch: number | undefined;
  /** The sites of the pref `webaios.call.sites`, sent by the parent with each watch: a web process does not get that pref. */
  private more: CallSite[] = [];

  /** The camera's and the microphone's capture in this window: [camera, microphone], each on only while it sends. */
  private capture(): { any: boolean; camera: boolean; mic: boolean } {
    const camera = {} as { value: number };
    const mic = {} as { value: number };
    try {
      Cc["@mozilla.org/mediaManagerService;1"].getService(Ci.nsIMediaManagerService).mediaCaptureWindowState(this.contentWindow, camera, mic, {}, {}, {}, {});
    } catch {
      return { any: false, camera: false, mic: false };
    }
    return { any: !!camera.value || !!mic.value, camera: camera.value === CAPTURE_ENABLED, mic: mic.value === CAPTURE_ENABLED };
  }

  private site(): CallSite | undefined {
    const host = this.document.location?.hostname ?? "";
    return [...this.more, ...CALL_SITES].find((s) => {
      try {
        return new RegExp(s.host).test(host);
      } catch {
        return false;
      }
    });
  }

  /** Null outside a call. The site's own buttons when it shows them (what the other participants see), else what this window sends. */
  private state(): CallState | null {
    const capture = this.capture();
    if (!capture.any) return null;
    const site = this.site();
    const shown = site?.buttons ? [...this.document.querySelectorAll(site.buttons)].filter((b: any) => b.checkVisibility()) : [];
    const on = (b: any) => b.getAttribute("data-is-muted") !== "true";
    return shown.length >= 2 ? { mic: on(shown[0]), camera: on(shown[1]) } : { mic: capture.mic, camera: capture.camera };
  }

  /**
   * A known site: its own shortcut, as the user would press it (an event made here is trusted), so the site and the
   * other participants see the change. Any other site: Firefox mutes or unmutes what this window sends.
   */
  private press(which: "mic" | "camera"): void {
    const win = this.contentWindow as any;
    const k: CallKey | undefined = this.site()?.[which];
    if (!k) {
      const on = this.capture()[which];
      const topic = `getUserMedia:${on ? "mute" : "unmute"}${which === "mic" ? "Audio" : "Video"}`;
      return Services.obs.notifyObservers(null, topic, String(win.windowGlobalChild.innerWindowId));
    }
    const target = this.document.activeElement ?? this.document.body ?? this.document.documentElement;
    for (const type of ["keydown", "keyup"])
      target.dispatchEvent(new win.KeyboardEvent(type, { key: k.key, code: k.code, keyCode: k.keyCode, which: k.keyCode, metaKey: !!k.meta, shiftKey: !!k.shift, bubbles: true, cancelable: true, composed: true, view: win }));
  }

  private unwatch(): void {
    if (this.watch !== undefined) clearInterval(this.watch);
    this.watch = undefined;
  }

  didDestroy(): void {
    this.unwatch();
  }

  receiveMessage(msg: { name: string; data: any }): unknown {
    switch (msg.name) {
      // The tab is left: a call's largest playing video goes to the player. Other pages keep their videos.
      case "call:leave": {
        if (!this.capture().any) return false;
        const area = (v: any) => v.clientWidth * v.clientHeight;
        const video = [...this.document.querySelectorAll("video")].filter((v: any) => !v.paused && v.readyState >= 2 && v.checkVisibility() && area(v) > 0).sort((a, b) => area(b) - area(a))[0];
        // Already floating: asking again would put it back in the page.
        if (!video || [...this.document.querySelectorAll("video")].some((v: any) => v.isCloningElementVisually)) return false;
        void (this.contentWindow as any).windowGlobalChild.getActor("PictureInPictureLauncher").togglePictureInPicture({ video, reason: "AutoPip" }, false);
        return true;
      }
      // The tab is in the background: the call's state now (null outside a call), then each change.
      case "call:watch": {
        this.unwatch();
        this.more = Array.isArray(msg.data) ? msg.data : [];
        let last = JSON.stringify(this.state());
        this.watch = setInterval(() => {
          const now = JSON.stringify(this.state());
          if (now !== last) this.sendAsyncMessage("call:state", JSON.parse((last = now)));
        }, WATCH_MS);
        return JSON.parse(last);
      }
      case "call:unwatch":
        return this.unwatch();
      case "call:press": {
        if (msg.data === "mic" || msg.data === "camera") this.press(msg.data);
        return undefined;
      }
    }
    return undefined;
  }
}
