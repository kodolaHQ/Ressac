import { cutFrameNetwork } from "./frame-network";

/**
 * The pill of the agent's last tab (ui/AgentPill.svelte) at the page's bottom right (window.css): a transparent frame of
 * sidebar.html?agentview that its document sizes to the pill, so the rest of the page keeps the mouse. Returns what
 * takes it down.
 */
export function mountAgentPill(win: Window): () => void {
  const doc = win.document;
  const f = doc.createElementNS("http://www.w3.org/1999/xhtml", "iframe") as HTMLIFrameElement;
  f.id = "webaios-agent-pill";
  // Out of the flow before it is appended (spike S8): in #browser's flex row a default iframe pushes the page aside.
  f.style.cssText = "position: fixed; z-index: 3; border: 0; background: transparent; width: 0; height: 0";
  doc.getElementById("browser")!.append(f);
  // Its document loads after createController has returned, and reads window.webaiosWindow (ui/install-api.ts).
  if (cutFrameNetwork(f)) f.src = "chrome://browser/content/webaios/sidebar.html?agentview";
  return () => f.remove();
}
