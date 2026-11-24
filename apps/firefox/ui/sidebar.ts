// First: ui/state.svelte.ts reads window.ressac as soon as a component imports it.
import "./install-api";
import { mount } from "svelte";
// Theme tokens.
import "../ui/theme.css";
import DesignApp from "../ui/DesignApp.svelte";
import HideApp from "./HideApp.svelte";
import AppBadge from "./BadgeApp.svelte";
import AgentPill from "./AgentPill.svelte";
import App from "./App.svelte";
import SiteWindow from "./SiteWindow.svelte";
import SiteHomeFrame from "./SiteHomeFrame.svelte";
import { site } from "./site/locale.svelte";
import { createHomeApi } from "./site-api";
import type { TabHomeController } from "../chrome/store/sites";

// Gecko fires `click` for the right and middle buttons in chrome documents: only a left click is a click here.
window.addEventListener("click", (e) => { if (e.button !== 0) e.stopImmediatePropagation(); }, true);

const params = new URLSearchParams(location.search);
// sidebar.html?site=<id>: a site app window's bar (SiteWindow's styles lay out #app).
if (params.has("site")) mount(SiteWindow, { target: document.body.appendChild(Object.assign(document.createElement("div"), { id: "app" })) });
// sidebar.html?badge=app:<dossier>: an app window's badge, over its page (transparent).
// sidebar.html?overlay: a design overlay, the bubble, the message or the cart (transparent).
// sidebar.html?agentview: the pill of the agent's last tab, over a main window's pages (transparent).
// sidebar.html?tabhome: an app's home over its essential tab's page (chrome/store/sites.ts renderTab).
else if (params.has("tabhome")) {
  const controller = (window.frameElement as Element & { ressacOverlay: { api: TabHomeController } }).ressacOverlay.api;
  site.locale = controller.locale();
  document.documentElement.style.cssText = document.body.style.cssText = "margin: 0; height: 100%; background: var(--bg); color: var(--text); font: 13px/1.4 var(--font-ui); overflow: hidden";
  const target = document.body.appendChild(Object.assign(document.createElement("div"), { id: "app" }));
  target.style.cssText = "display: flex; flex-direction: column; height: 100%";
  mount(SiteHomeFrame, { target, props: { api: createHomeApi(controller), controller } });
} else if (params.has("hide") || params.has("hide-bubble")) {
  // sidebar.html?hide / ?hide-bubble: « Cacher pour l'agent »'s layer over the page and its bubble (transparent).
  document.documentElement.style.background = document.body.style.background = "transparent";
  mount(HideApp, { target: document.body.appendChild(Object.assign(document.createElement("div"), { id: "app" })), props: { part: params.has("hide") ? "layer" : "bubble" } });
} else if (params.has("badge") || params.has("overlay") || params.has("agentview")) {
  document.documentElement.style.background = "transparent";
  document.body.style.background = "transparent";
  const target = document.body.appendChild(Object.assign(document.createElement("div"), { id: "app" }));
  if (params.has("overlay")) mount(DesignApp, { target });
  else if (params.has("agentview")) mount(AgentPill, { target });
  else mount(AppBadge, { target, props: { id: params.get("badge") ?? "" } });
} else {
  // DesignButton's chevron opens the menu on click, and ContextMenu's window click listener would close it
  // at once (Applications.svelte stops the click for that reason): stopped here first, registered before the mount.
  window.addEventListener("click", (e) => {
    if ((e.target as Element | null)?.closest?.('.design > button.chevron')) e.stopImmediatePropagation();
  });
  mount(App, { target: document.body });
}
