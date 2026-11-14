import { format } from "../../shared/i18n";
import type { Band, WindowId } from "../../shared/model";
import { HOST_EXITED } from "../agent/host";
import type { RessacStore } from "../store";

const XHTML = "http://www.w3.org/1999/xhtml";

/** « 40 s », « 1 min 50 ». */
export function duration(ms: number, locale: string): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? format(locale, "chrome-duration-seconds", { s: String(s) }) : format(locale, "chrome-duration-minutes", { m: String(Math.floor(s / 60)), s: String(s % 60).padStart(2, "0") });
}
export const stats = (b: Band, now: number, locale: string) => format(locale, "chrome-search-stats", { pages: b.pages, duration: duration(now - b.startedAt, locale) });

/**
 * The band of the agent's search tab, above the page, shown while that tab is the window's active one. It says what the
 * agent does, and in « à vous » hands the page back to the user (Continuer). The page moves down by its height
 * (--ressac-search-band, under the site banner's --ressac-banner). Returns what takes it down.
 */
export function mountSearchBand(win: Window, store: RessacStore, windowId: WindowId): () => void {
  const doc = win.document;
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string) => {
    const e = doc.createElementNS(XHTML, tag) as HTMLElementTagNameMap[K];
    if (cls) e.className = cls;
    return e;
  };
  const band = el("div");
  band.id = "ressac-search-band";
  band.dataset.testid = "search-band";
  band.setAttribute("role", "status");
  band.setAttribute("aria-live", "off"); // set before any text changes, so a screen reader announces the « à vous » text
  const dot = el("span", "dot");
  const what = el("span", "what");
  const text = el("span", "text");
  text.dataset.testid = "search-band-text";
  const small = el("small");
  what.append(text, small);
  const button = (testid: string, cls = "") => {
    const b = el("button", cls);
    b.type = "button";
    b.dataset.testid = testid;
    return b;
  };
  const go = button("search-continue", "go");
  const stop = button("search-stop");
  const close = button("search-close");
  band.append(dot, what, go, stop, close);
  doc.getElementById("browser")!.append(band);

  let tabId: string | undefined;
  let shown: Band | undefined;
  let tick: ReturnType<typeof setInterval> | undefined;
  const call = (method: string) => () => tabId && void store.agent.request(method, { id: tabId }).catch(() => {});
  go.addEventListener("click", call("search.continue"));
  stop.addEventListener("click", call("search.stop"));
  close.addEventListener("click", call("search.dismiss"));

  const paint = () => {
    if (shown?.state === "working") small.textContent = stats(shown, Date.now(), store.state.locale);
  };
  const render = () => {
    const say = (id: string) => format(store.state.locale, id);
    band.setAttribute("aria-label", say("chrome-search-label"));
    go.textContent = say("chrome-search-continue");
    stop.textContent = say("chrome-search-stop");
    close.textContent = say("chrome-search-close");
    const f = store.state.windows.find((x) => x.id === windowId);
    const active = f?.active[f.activeSpace];
    const b = active ? store.state.tabs[active]?.agentSearch : undefined;
    tabId = b ? (active ?? undefined) : undefined;
    shown = b;
    // Kept as it was when there is none: the text stays readable while the band fades out.
    if (b) {
      band.setAttribute("aria-live", b.state === "yours" ? "polite" : "off");
      band.dataset.state = b.state;
      text.textContent = b.text;
      small.textContent = b.state === "yours" ? "" : stats(b, Date.now(), store.state.locale);
    }
    band.toggleAttribute("data-shown", !!b);
    go.hidden = b?.state !== "yours";
    stop.hidden = b?.state === "idle";
    close.hidden = b?.state !== "idle";
    if (b?.state === "working" && !tick) tick = setInterval(paint, 1000);
    else if (b?.state !== "working" && tick) {
      clearInterval(tick);
      tick = undefined;
    }
    doc.documentElement.toggleAttribute("ressac-search-band", !!b);
    resize();
  };
  // Its room: its height and the 8 px gap under it, as the page has to the window's edge.
  const resize = () => doc.documentElement.style.setProperty("--ressac-search-band", shown ? `${band.getBoundingClientRect().height + 8}px` : "0px");
  const observer = new ResizeObserver(resize);
  observer.observe(band);
  render();
  // The host is gone: its bands will never end.
  const clear = () => {
    for (const t of Object.values(store.state.tabs)) if (t.agentSearch) void store.dispatch({ type: "setAgentSearch", id: t.id, band: null });
  };
  const off = [store.subscribe(render), store.agent.on(HOST_EXITED, clear)];
  return () => {
    off.forEach((f) => f());
    clearInterval(tick);
    observer.disconnect();
  };
}
