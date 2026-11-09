// First: ui/etat.svelte.ts reads window.webaios as soon as a component imports it.
import "./install-api";
import { mount } from "svelte";
// Theme tokens (frozen: imported, never modified).
import "../ui/theme.css";
import DesignApp from "../ui/DesignApp.svelte";
import PastilleApp from "../ui/PastilleApp.svelte";
import App from "./App.svelte";
import SiteWindow from "./SiteWindow.svelte";

const params = new URLSearchParams(location.search);
// sidebar.html?site=<id>: a site app window's bar (FenetreSite's styles lay out #app).
if (params.has("site")) mount(SiteWindow, { target: document.body.appendChild(Object.assign(document.createElement("div"), { id: "app" })) });
// sidebar.html?pastille=app:<dossier>: an app window's badge, over its page (transparent).
// sidebar.html?calque: a design overlay, the bubble, the message or the cart (transparent).
else if (params.has("pastille") || params.has("calque")) {
  document.documentElement.style.background = "transparent";
  document.body.style.background = "transparent";
  const target = document.body.appendChild(Object.assign(document.createElement("div"), { id: "app" }));
  if (params.has("calque")) mount(DesignApp, { target });
  else mount(PastilleApp, { target, props: { id: params.get("pastille") ?? "" } });
} else {
  // BoutonDesign's chevron (frozen) opens the menu on click, and MenuContextuel's window click listener would close it
  // at once (Applications.svelte stops the click for that reason): stopped here first, registered before the mount.
  window.addEventListener("click", (e) => {
    if ((e.target as Element | null)?.closest?.('button[aria-label="Menu du mode design"]')) e.stopImmediatePropagation();
  });
  mount(App, { target: document.body });
}
