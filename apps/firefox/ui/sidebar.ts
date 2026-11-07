// First: navigateur's etat.svelte.ts reads window.webaios as soon as a component imports it.
import "./install-api";
import { mount } from "svelte";
// Theme tokens shared with the Electron app (frozen: imported, never modified).
import "../../navigateur/src/renderer/theme.css";
import PastilleApp from "../../navigateur/src/renderer/PastilleApp.svelte";
import App from "./App.svelte";
import SiteWindow from "./SiteWindow.svelte";

const params = new URLSearchParams(location.search);
// sidebar.html?site=<id>: a site app window's bar (FenetreSite's styles lay out #app).
if (params.has("site")) mount(SiteWindow, { target: document.body.appendChild(Object.assign(document.createElement("div"), { id: "app" })) });
// sidebar.html?pastille=app:<dossier>: an app window's badge, over its page (as renderer/pastille.ts: transparent).
else if (params.has("pastille")) {
  document.documentElement.style.background = "transparent";
  document.body.style.background = "transparent";
  mount(PastilleApp, { target: document.body.appendChild(Object.assign(document.createElement("div"), { id: "app" })), props: { id: params.get("pastille") ?? "" } });
} else mount(App, { target: document.body });
