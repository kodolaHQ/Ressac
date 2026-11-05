import type { IdFenetre, IdOnglet, IdProfil } from "../../../navigateur/src/commun/modele";
import type { SitePermissions } from "./site-permissions";

const { Integration } = ChromeUtils.importESModule("resource://gre/modules/Integration.sys.mjs");

/** Firefox's content permission types we ask about, as the kinds of SitePermissions.handle. Any other: refused, no question. */
const KINDS: Record<string, string> = {
  "desktop-notification": "notifications",
  geolocation: "geolocation",
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
  /** The WebAiOs tab behind a browser (a popup's: its opener's tab), or null. */
  tabOf(browser: any): { ongletId: IdOnglet; fenetreId: IdFenetre; profil: IdProfil } | null;
  isInvisible(browser: any): boolean;
}): () => void {
  const decide = (type: string, request: any) => {
    // After a tab closes, the request throws on any use.
    const respond = (ok: boolean) => {
      try {
        if (ok) request.allow();
        else request.cancel();
      } catch {}
    };
    const kind = KINDS[type];
    const browser = request.element;
    const tab = kind && browser && !o.isInvisible(browser) ? o.tabOf(browser) : null;
    // Electron's origineDe: no question for an opaque or unreadable origin (file:, data:, the system principal…).
    let origine = "null";
    try {
      origine = new URL(request.principal.originNoSuffix).origin;
    } catch {}
    if (!kind || !tab || origine === "null") return respond(false);
    const gone = new AbortController();
    const unwatch = watchGone(browser, () => gone.abort());
    o.sitePermissions
      .handle({ ...tab, origine, kind, signal: gone.signal })
      .then(respond, () => respond(false))
      .finally(unwatch);
  };
  const factory = (base: object) => ({
    __proto__: base,
    createPermissionPrompt: (type: string, request: any) => ({ prompt: () => decide(type, request) }),
  });
  Integration.contentPermission.register(factory);
  return () => Integration.contentPermission.unregister(factory);
}
