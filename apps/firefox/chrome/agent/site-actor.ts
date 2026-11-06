// Site app actor: in every frame of a site app's container, an Xray sandbox per document runs what the chrome published
// for that container (the page guard, then the app's scripts), as Firefox runs an extension's content scripts. The
// sandbox sees the page's DOM through Xrays: neither the page's own JS objects nor the chrome.
// Kept small: the build copies this file, so any change here needs a rebuild of the app (build:ui).

/** What the chrome publishes for one container (store/sites.ts publishSiteFrames). Plan 32 adds fields, not code here. */
export type SiteFrameData = { id: string; garde: string; scripts: { code: string; nom: string }[] };

// Keep in sync with store/sites.ts SITE_FRAMES.
const SITE_FRAMES = "webaios-sites";

/** Nothing comes from the child: the parent side exists for the registration only. */
export class WebAiOsSiteParent extends JSWindowActorParent {}

export class WebAiOsSiteChild extends JSWindowActorChild {
  private sandbox: unknown = null;

  /** The container's data, or null in any frame outside a site app (every ordinary tab). */
  private data(): SiteFrameData | null {
    const all = Services.cpmm.sharedData.get(SITE_FRAMES) as Map<number, SiteFrameData> | null;
    return all?.get((this.document as any).nodePrincipal.originAttributes.userContextId) ?? null;
  }

  private run(code: string, name: string) {
    try {
      Cu.evalInSandbox(code, this.sandbox, "latest", name, 1);
    } catch (e) {
      console.error(`[site] ${name}:`, e);
    }
  }

  // DOMWindowCreated: the sandbox and the guard, before the page's first script. DOMContentLoaded (capture, listened
  // above the page's window): the scripts, even when the page stops the event's propagation.
  handleEvent(e: Event) {
    if (e.target !== this.document) return;
    const data = this.data();
    if (!data) return;
    if (!this.sandbox) {
      const win = this.contentWindow;
      this.sandbox = Cu.Sandbox((this.document as any).nodePrincipal, { sandboxPrototype: win, wantXrays: true, wantComponents: false, sameZoneAs: win, sandboxName: `WebAiOs site ${data.id}` });
      // The page's own legacy `Components` shim (constants only) would show through the prototype: shadowed.
      Object.defineProperty(this.sandbox, "Components", { value: undefined });
      this.run(data.garde, "webaios-garde-page.js");
    }
    if (e.type === "DOMContentLoaded") for (const s of data.scripts) this.run(s.code, s.nom);
  }
}
