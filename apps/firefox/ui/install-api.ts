import { createApi } from "./api";

// Imported first by sidebar.ts: navigateur's etat.svelte.ts reads window.webaios as it loads.
// The controller sets the iframe's src only once it exists (chrome/window/index.ts).
const win = window.parent.webaiosWindow;
if (!win) throw new Error("WebAiOs UI loaded before its window controller");
window.webaios = createApi(win);
