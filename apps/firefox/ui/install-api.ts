import { createApi, type ApiFirefox } from "./api";
import { settingsPageDocument } from "./settings-api";
import type { OverlayApi } from "../shared/api";
import { createBadgeApi } from "./badge-api";
import { wrapOverlayApi } from "./overlay-api";
import { createSiteApi, inertRessac } from "./site-api";
import type { BadgeChrome } from "../chrome/store/apps";

// Imported first by sidebar.ts: ui/state.svelte.ts reads window.ressac as it loads.
// The controller sets the iframe's src only once it exists (chrome/window/index.ts, chrome/window/site-window.ts).
// An app badge's frame and a design overlay's get their api on the frame element (chrome/window/app-window.ts,
// chrome/window/design-overlays.ts), set before its src.
const params = new URLSearchParams(location.search);
if (params.has("site")) {
  const site = window.parent.ressacSiteWindow;
  if (!site) throw new Error("Ressac site bar loaded before its window controller");
  window.ressac = inertRessac({ site: createSiteApi(site) }) as ApiFirefox;
  // Its aura and the window's keys: the controller does not see this frame's load.
  window.parent.ressacSiteBarStarted?.(window);
} else if (params.has("tabhome")) {
  // An essential tab's home: SiteHomeFrame mounted by sidebar.ts on the frame's controller, nothing else of the UI.
  if (!(window.frameElement as (Element & { ressacOverlay?: unknown }) | null)?.ressacOverlay) throw new Error("Ressac tab home loaded before its controller");
  window.ressac = inertRessac({}) as ApiFirefox;
} else if (params.has("badge")) {
  const overlay = (window.frameElement as (Element & { ressacOverlay?: { api: BadgeChrome } }) | null)?.ressacOverlay;
  if (!overlay) throw new Error("Ressac badge loaded before its window controller");
  window.ressac = inertRessac(createBadgeApi(overlay.api)) as ApiFirefox;
} else if (params.has("overlay")) {
  const overlay = (window.frameElement as (Element & { ressacOverlay?: { api: OverlayApi } }) | null)?.ressacOverlay;
  if (!overlay) throw new Error("Ressac design overlay loaded before its window controller");
  window.ressac = inertRessac(wrapOverlayApi(overlay.api)) as ApiFirefox;
} else {
  const win = window.parent.ressacWindow;
  if (!win) throw new Error("Ressac UI loaded before its window controller");
  // The passport's Settings API exists only in the document that shows ressac://settings (design § 9.2), not the agent panel's.
  window.ressac = createApi(win, { settingsPage: settingsPageDocument(location) });
  // Its aura and the window's key and mouse listeners: the controller does not see this frame's load.
  win.uiStarted(window);
}

// Gecko's macOS widget still fires keypress for a printable key whose keydown was consumed when the document is in the
// parent process, as these UI documents are (web content never gets it). xterm counts on it being dropped: without
// this, each key typed in the agent terminal reached the agent twice.
let lastKeydown: KeyboardEvent | undefined;
window.addEventListener("keydown", (e) => (lastKeydown = e), true);
window.addEventListener(
  "keypress",
  (e) => {
    if (!lastKeydown?.defaultPrevented || lastKeydown.code !== e.code) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  },
  true,
);
