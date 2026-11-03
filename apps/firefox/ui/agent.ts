import "./install-api";
import { mount } from "svelte";
import "../../navigateur/src/renderer/theme.css";
import AgentApp from "./AgentApp.svelte";

mount(AgentApp, { target: document.body });
