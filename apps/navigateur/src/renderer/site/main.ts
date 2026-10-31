import { mount } from "svelte";
import FenetreSite from "./FenetreSite.svelte";
import "../theme.css";

mount(FenetreSite, { target: document.getElementById("app")! });
