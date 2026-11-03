import { mount } from "svelte";
import DesignApp from "./DesignApp.svelte";
import "./theme.css";

// Vue transparente posée sur la page : seule la bulle (ou le panier) a un fond.
document.documentElement.style.background = "transparent";
document.body.style.background = "transparent";
mount(DesignApp, { target: document.getElementById("app")! });
