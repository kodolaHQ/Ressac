import { mount } from "svelte";
// Theme tokens shared with the Electron app (frozen: imported, never modified).
import "../../navigateur/src/renderer/theme.css";
import Sidebar from "./Sidebar.svelte";

mount(Sidebar, { target: document.body });
