import "./install-api";
import { mount } from "svelte";
import "../ui/theme.css";
import AgentApp from "./AgentApp.svelte";

mount(AgentApp, { target: document.body });
