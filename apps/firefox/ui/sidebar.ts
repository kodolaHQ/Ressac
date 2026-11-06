// First: navigateur's etat.svelte.ts reads window.webaios as soon as a component imports it.
import "./install-api";
import { mount } from "svelte";
// Theme tokens shared with the Electron app (frozen: imported, never modified).
import "../../navigateur/src/renderer/theme.css";
import App from "./App.svelte";
import SiteWindow from "./SiteWindow.svelte";

// sidebar.html?site=<id>: a site app window's bar (FenetreSite's styles lay out #app).
if (new URLSearchParams(location.search).has("site")) mount(SiteWindow, { target: document.body.appendChild(Object.assign(document.createElement("div"), { id: "app" })) });
else mount(App, { target: document.body });
