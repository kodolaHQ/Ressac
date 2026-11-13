import type { AgentViewState } from "../../shared/api";
import type { AccessState } from "../../shared/model";
import { privateTab } from "../../shared/model";
import { ACTIVITY_HOLD_MS, createActivity } from "../../core/agent/activity";
import type { Store } from "../store/store";
import type { WindowRegistry } from "../store/windows";
import { HOST_EXITED, type AgentHost } from "./host";

const XHTML = "http://www.w3.org/1999/xhtml";
const CAPTURE_EVERY_MS = 700;
const THUMBNAIL_WIDTH = 320;

export interface AgentView {
  state(): AgentViewState | null;
  onState(callback: (s: AgentViewState | null) => void): () => void;
  watch(callback: (frame: string | null) => void): () => void;
  /** Tests only (WEBAIOS_TEST_AGENT_VIEW): the captures taken and how long each took, in ms. */
  readonly test?: { captures: number; ms: number[] };
}

/**
 * The tab the agent last acted on (`agent.activity` from the host, `running` from `access`) and, only while a watcher is
 * subscribed, thumbnails of it: one capture at a time, at most every 700 ms, never in a minimised or hidden window, and
 * only when a tool runs there or the tab moved since the last frame.
 */
export function createAgentView(o: { store: Store; host: AgentHost; access: () => AccessState; windows: WindowRegistry }): AgentView {
  const activity = createActivity(Date.now);
  const listeners = new Set<(s: AgentViewState | null) => void>();
  const watchers = new Set<(frame: string | null) => void>();
  const test = Services.env.get("WEBAIOS_TEST_AGENT_VIEW") ? { captures: 0, ms: [] as number[] } : undefined;
  let shown: AgentViewState | null = null;
  /** The tab loaded or changed since the last frame. */
  let moved = true;
  let pending = false;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  let loop: ReturnType<typeof setTimeout> | undefined;

  const compute = (): AgentViewState | null => {
    const a = activity.state();
    if (!a) return null;
    const state = o.store.state;
    const tab = state.tabs[a.tab];
    if (!tab || privateTab(state, tab)) {
      activity.closed(a.tab);
      return null;
    }
    let site = "";
    try {
      site = new URL(tab.url).hostname.replace(/^www\./, "");
    } catch {}
    return { tab: a.tab, label: a.label, title: tab.title, site, ...(tab.favicon ? { icon: tab.favicon } : {}), running: a.running };
  };
  const send = (frame: string | null) => watchers.forEach((cb) => cb(frame));
  const refresh = () => {
    const next = compute();
    // Re-read once the hold may have passed.
    clearTimeout(expiry);
    if (next) expiry = setTimeout(refresh, ACTIVITY_HOLD_MS + 100);
    if (JSON.stringify(next) === JSON.stringify(shown)) return;
    if (next?.tab !== shown?.tab) moved = true;
    shown = next;
    listeners.forEach((cb) => cb(next));
    if (!next) send(null);
  };

  o.host.on("agent.activity", (a: { tab: string; label: string }) => {
    activity.event({ tab: String(a.tab), label: String(a.label) });
    moved = true;
    refresh();
  });
  const running = new Set<string>();
  const sync = () => {
    const tabs = o.access().tabs;
    for (const id of new Set([...running, ...Object.keys(tabs)])) {
      const on = !!tabs[id]?.running;
      activity.running(id, on);
      if (on) running.add(id);
      else running.delete(id);
    }
    refresh();
  };
  o.host.on("access", sync);
  o.host.on(HOST_EXITED, sync);
  o.store.subscribe((s, p) => {
    const id = shown?.tab;
    if (id && (s.tabs[id]?.url !== p.tabs[id]?.url || s.tabs[id]?.loading !== p.tabs[id]?.loading)) moved = true;
    refresh();
  });

  async function capture() {
    if (pending || !shown || !(moved || shown.running)) return;
    const id = shown.tab;
    const entry = o.windows.get(o.store.state.tabs[id]?.windowId ?? "");
    const win: any = entry?.window;
    if (!win || win.windowState === win.STATE_MINIMIZED || win.document.hidden) return;
    moved = false;
    // Never ensure(): a tab without a XUL tab stays unloaded, the UI shows its site and icon.
    const browser = entry!.controller.browserOf(id);
    const page = browser?.browsingContext?.currentWindowGlobal;
    if (!page || !/^https?:/.test(browser.currentURI?.spec ?? "")) return send(null);
    pending = true;
    const start = ChromeUtils.now();
    try {
      const bitmap = await page.drawSnapshot(null, THUMBNAIL_WIDTH / (browser.clientWidth || win.innerWidth), "white");
      let frame: string;
      try {
        const canvas = win.document.createElementNS(XHTML, "canvas") as HTMLCanvasElement;
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
        frame = canvas.toDataURL("image/jpeg", 0.7);
      } finally {
        bitmap.close();
      }
      if (test) {
        test.captures++;
        test.ms.push(ChromeUtils.now() - start);
      }
      // The tab may have closed or turned private while it was drawn.
      refresh();
      if (shown?.tab === id) send(frame);
    } catch (e) {
      console.warn("[agent-view] capture failed:", e);
    } finally {
      pending = false;
    }
  }
  const tick = () => {
    loop = setTimeout(tick, CAPTURE_EVERY_MS);
    void capture();
  };

  return {
    state: () => shown,
    onState(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    watch(cb) {
      watchers.add(cb);
      // A new watcher gets a frame at once.
      moved = true;
      if (watchers.size === 1) tick();
      return () => {
        watchers.delete(cb);
        if (!watchers.size) clearTimeout(loop);
      };
    },
    test,
  };
}
