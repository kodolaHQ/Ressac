import type { PendingRequest, WindowId } from "../../shared/model";
import type { WebAiOsStore } from "../store";
import type { SitePermission } from "../store/site-permissions";
import { bannerText } from "./banner-text";

const XHTML = "http://www.w3.org/1999/xhtml";
/** These open as the UI's modal (as modale.svelte.ts's estDemandeAgent, not importable here: it holds runes). */
const AGENT = ["lire-onglet", "outils-dev", "donnees-widget", "extension", "console-extension"];

/**
 * The site question of the displayed tab, above the page, which moves down by its height
 * (--webaios-banner): the oldest question for this window or its active tab. Returns what
 * takes it down.
 */
export function mountSiteBanner(win: Window, store: WebAiOsStore, windowId: WindowId): () => void {
  const doc = win.document;
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K) => doc.createElementNS(XHTML, tag) as HTMLElementTagNameMap[K];
  const banner = el("div");
  banner.id = "webaios-banner";
  banner.dataset.testid = "demande-permission";
  banner.setAttribute("role", "alertdialog");
  banner.setAttribute("aria-label", "Demande d'autorisation");
  banner.hidden = true;
  const text = el("span");
  const refuse = el("button");
  refuse.textContent = "Refuser";
  const allow = el("button");
  allow.textContent = "Autoriser";
  allow.className = "autoriser";
  banner.append(text, refuse, allow);
  doc.getElementById("browser")!.append(banner);

  let shown: PendingRequest | undefined;
  refuse.addEventListener("click", () => shown && store.questions.answer(shown.id, "refuser"));
  allow.addEventListener("click", () => shown && store.questions.answer(shown.id, "autoriser"));
  const render = () => {
    const f = store.state.fenetres.find((x) => x.id === windowId);
    const active = f?.actif[f.espaceActif];
    const d = store.questions.pending().find((d) => (d.fenetreId ? d.fenetreId === windowId : d.ongletId === null || d.ongletId === active));
    shown = d && !d.permissions.some((p) => AGENT.includes(p)) ? d : undefined;
    banner.hidden = !shown;
    if (shown) text.textContent = bannerText(shown as PendingRequest & { permissions: SitePermission[] });
  };
  // Its height follows its text (a long link wraps) and the window's width.
  const resize = new ResizeObserver(() => doc.documentElement.style.setProperty("--webaios-banner", `${banner.getBoundingClientRect().height}px`));
  resize.observe(banner);
  render();
  const off = [store.questions.onChange(render), store.subscribe(render)];
  return () => {
    off.forEach((f) => f());
    resize.disconnect();
  };
}
