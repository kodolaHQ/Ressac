// First: navigateur's etat.svelte.ts reads window.webaios as soon as a component imports it.
import "./install-api";
import { mount } from "svelte";
// Theme tokens shared with the Electron app (frozen: imported, never modified).
import "../../navigateur/src/renderer/theme.css";
import App from "./App.svelte";

mount(App, { target: document.body });
