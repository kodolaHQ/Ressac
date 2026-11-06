import { createApi, type ApiFirefox } from "./api";
import { createSiteApi, siteWebaios } from "./site-api";

// Imported first by sidebar.ts: navigateur's etat.svelte.ts reads window.webaios as it loads.
// The controller sets the iframe's src only once it exists (chrome/window/index.ts, chrome/window/site-window.ts).
if (new URLSearchParams(location.search).has("site")) {
  const site = window.parent.webaiosSiteWindow;
  if (!site) throw new Error("WebAiOs site bar loaded before its window controller");
  window.webaios = siteWebaios(createSiteApi(site)) as ApiFirefox;
} else {
  const win = window.parent.webaiosWindow;
  if (!win) throw new Error("WebAiOs UI loaded before its window controller");
  window.webaios = createApi(win);
}

// Gecko's macOS widget still fires keypress for a printable key whose keydown was consumed when the document is in the
// parent process, as these UI documents are (web content never gets it). xterm counts on it being dropped: without
// this, each key typed in the agent terminal reached the agent twice.
let lastKeydown: KeyboardEvent | undefined;
window.addEventListener("keydown", (e) => (lastKeydown = e), true);
window.addEventListener(
  "keypress",
  (e) => {
    if (!lastKeydown?.defaultPrevented || lastKeydown.code !== e.code) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  },
  true,
);
