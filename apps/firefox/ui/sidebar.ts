// First: ui/state.svelte.ts reads window.webaios as soon as a component imports it.
import "./install-api";
import { mount } from "svelte";
// Theme tokens.
import "../ui/theme.css";
import DesignApp from "../ui/DesignApp.svelte";
import AppBadge from "./BadgeApp.svelte";
import App from "./App.svelte";
import SiteWindow from "./SiteWindow.svelte";

// Gecko fires `click` for the right and middle buttons in chrome documents: only a left click is a click here.
window.addEventListener("click", (e) => { if (e.button !== 0) e.stopImmediatePropagation(); }, true);

const params = new URLSearchParams(location.search);
// sidebar.html?site=<id>: a site app window's bar (SiteWindow's styles lay out #app).
if (params.has("site")) mount(SiteWindow, { target: document.body.appendChild(Object.assign(document.createElement("div"), { id: "app" })) });
// sidebar.html?badge=app:<dossier>: an app window's badge, over its page (transparent).
// sidebar.html?overlay: a design overlay, the bubble, the message or the cart (transparent).
else if (params.has("badge") || params.has("overlay")) {
  document.documentElement.style.background = "transparent";
  document.body.style.background = "transparent";
  const target = document.body.appendChild(Object.assign(document.createElement("div"), { id: "app" }));
  if (params.has("overlay")) mount(DesignApp, { target });
  else mount(AppBadge, { target, props: { id: params.get("badge") ?? "" } });
} else {
  // DesignButton's chevron opens the menu on click, and ContextMenu's window click listener would close it
  // at once (Applications.svelte stops the click for that reason): stopped here first, registered before the mount.
  window.addEventListener("click", (e) => {
    if ((e.target as Element | null)?.closest?.('button[aria-label="Menu du mode design"]')) e.stopImmediatePropagation();
  });
  mount(App, { target: document.body });
}
