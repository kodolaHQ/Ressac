import { mount } from "svelte";
import PastilleApp from "./PastilleApp.svelte";
import "./theme.css";

// Vue transparente posée sur une fenêtre d'appli : le fond de l'interface ne doit pas la masquer.
document.documentElement.style.background = "transparent";
document.body.style.background = "transparent";
const id = new URLSearchParams(location.search).get("id") ?? "";
mount(PastilleApp, { target: document.getElementById("app")!, props: { id } });
