import "./install-api";
import { mount } from "svelte";
import "../ui/theme.css";
import AgentApp from "./AgentApp.svelte";

// Gecko fires `click` for the right and middle buttons in chrome documents: only a left click is a click here.
window.addEventListener("click", (e) => { if (e.button !== 0) e.stopImmediatePropagation(); }, true);

mount(AgentApp, { target: document.body });
