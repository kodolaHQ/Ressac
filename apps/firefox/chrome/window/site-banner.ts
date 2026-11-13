import type { PendingRequest, WindowId } from "../../shared/model";
import type { RessacStore } from "../store";
import type { SitePermission } from "../store/site-permissions";
import { bannerText } from "./banner-text";

const XHTML = "http://www.w3.org/1999/xhtml";
/** These open as the UI's modal (as modal.svelte.ts's isAgentRequest, not importable here: it holds runes). */
const AGENT = ["read-tab", "devtools", "widget-data", "extension", "extension-console", "agent-address"];

/**
 * The site question of the displayed tab, above the page, which moves down by its height
 * (--ressac-banner): the oldest question for this window or its active tab. Returns what
 * takes it down.
 */
export function mountSiteBanner(win: Window, store: RessacStore, windowId: WindowId): () => void {
  const doc = win.document;
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K) => doc.createElementNS(XHTML, tag) as HTMLElementTagNameMap[K];
  const banner = el("div");
  banner.id = "ressac-banner";
  banner.dataset.testid = "permission-request";
  banner.setAttribute("role", "alertdialog");
  banner.setAttribute("aria-label", "Demande d'autorisation");
  banner.hidden = true;
  const text = el("span");
  const deny = el("button");
  deny.textContent = "Refuser";
  const allow = el("button");
  allow.textContent = "Autoriser";
  allow.className = "allow";
  banner.append(text, deny, allow);
  doc.getElementById("browser")!.append(banner);

  let shown: PendingRequest | undefined;
  deny.addEventListener("click", () => shown && store.questions.answer(shown.id, "deny"));
  allow.addEventListener("click", () => shown && store.questions.answer(shown.id, "allow"));
  const render = () => {
    const f = store.state.windows.find((x) => x.id === windowId);
    const active = f?.active[f.activeSpace];
    const d = store.questions.pending().find((d) => (d.windowId ? d.windowId === windowId : d.tabId === null || d.tabId === active));
    shown = d && !d.permissions.some((p) => AGENT.includes(p)) ? d : undefined;
    banner.hidden = !shown;
    if (shown) text.textContent = bannerText(shown as PendingRequest & { permissions: SitePermission[] });
  };
  // Its height follows its text (a long link wraps) and the window's width.
  const resize = new ResizeObserver(() => doc.documentElement.style.setProperty("--ressac-banner", `${banner.getBoundingClientRect().height}px`));
  resize.observe(banner);
  render();
  const off = [store.questions.onChange(render), store.subscribe(render)];
  return () => {
    off.forEach((f) => f());
    resize.disconnect();
  };
}
