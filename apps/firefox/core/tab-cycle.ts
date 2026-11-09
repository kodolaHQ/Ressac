import type { Action, TabCycleMessage, TabsPanel } from "../shared/api";
import type { BrowserState, WindowId, TabId } from "../shared/model";
import { createGrouper } from "./tabs/grouper";
import { walkableTabs } from "../shared/walkable-tabs";
import { advance, start, visibleWindow, noteUsage, recentOrder, remove, type Walk } from "./recents";

/** The panel appears only if ⌃ is still held after this delay (a quick back-and-forth does not make it blink). */
const PANEL_DELAY_MS = 200;
/** Capture of the tab that became active, after the fact: it never delays the tab change. */
const CAPTURE_DELAY_MS = 1000;

interface InProgress {
  p: Walk;
  timeout: ReturnType<typeof setTimeout> | undefined;
  /** The panel was sent to the UI (null will have to be sent to it). */
  visible: boolean;
}

/**
 * ⌃Tab Zen-style, main process side: most-recently-used order per window, cycling while ⌃ is held,
 * tab activated only on ⌃ release (or on a click in the panel).
 */
export class TabCycle {
  /** Tabs used, from most to least recent, per window. */
  private histories = new Map<WindowId, TabId[]>();
  private actives = new Map<WindowId, TabId | null>();
  private cycle = new Map<WindowId, InProgress>();
  private readonly delayMs: number;
  private captures: ReturnType<typeof createGrouper>;

  constructor(
    private readonly o: {
      state(): BrowserState;
      dispatch(a: Action): void;
      send(windowId: WindowId, p: TabsPanel | null): void;
      preview(id: TabId): string | null;
      capture(windowId: WindowId): Promise<void>;
      /** Gives the keyboard back to the page displayed in the window (the UI took it to capture the panel's background). */
      restoreFocus(windowId: WindowId): void;
      /**
       * The main window has focus. Otherwise (detached developer tools…), the release of ⌃ would never reach it
       * and the window would not lose focus: a cycle would stay stuck there.
       */
      isFocused(windowId: WindowId): boolean;
      delayMs?: number;
    },
  ) {
    this.delayMs = o.delayMs ?? PANEL_DELAY_MS;
    this.captures = createGrouper(CAPTURE_DELAY_MS, (f) => void this.o.capture(f).catch(() => {}));
  }

  /** ⌃Tab (1) or ⌃⇧Tab (-1) from the menu. */
  browse(windowId: WindowId, delta: 1 | -1): void {
    const current = this.cycle.get(windowId);
    if (current) {
      current.p = advance(current.p, delta);
      if (current.visible) this.sendPanel(windowId, current);
      return;
    }
    const p = start(recentOrder(this.o.state(), windowId, this.histories.get(windowId) ?? []), delta);
    if (!p) return;
    // Window without focus: immediate switch, like a brief press, without cycle or panel.
    if (!this.o.isFocused(windowId)) return this.o.dispatch(this.activation(windowId, p.list[p.selection]!));
    const running: InProgress = { p, timeout: undefined, visible: false };
    this.cycle.set(windowId, running);
    // The displayed tab may have changed since its last capture: its card must be up to date.
    void this.o.capture(windowId).catch(() => {});
    running.timeout = setTimeout(() => {
      running.timeout = undefined;
      if (this.cycle.get(windowId) !== running) return;
      running.visible = true;
      this.sendPanel(windowId, running);
    }, this.delayMs);
  }

  /** ⌃ released in the window (UI or page): activates the selection. No effect outside a cycle. */
  keyReleased(windowId: WindowId): void {
    const c = this.cycle.get(windowId);
    if (c) this.finish(windowId, c.p.list[c.p.selection]);
  }

  /** Message from the panel (already validated by zod). */
  message(windowId: WindowId, m: TabCycleMessage): void {
    const c = this.cycle.get(windowId);
    if (!c) return;
    switch (m.type) {
      case "valider":
        return this.keyReleased(windowId);
      case "annuler":
        return this.cancel(windowId);
      case "choisir":
        if (c.p.list.includes(m.id)) this.finish(windowId, m.id);
        return;
      case "survoler": {
        const i = c.p.list.indexOf(m.id);
        if (i < 0 || i === c.p.selection) return;
        c.p = { ...c.p, selection: i };
        if (c.visible) this.sendPanel(windowId, c);
        return;
      }
      case "avancer":
        return this.browse(windowId, m.delta);
    }
  }

  /** Esc: close without changing tab. */
  cancel(windowId: WindowId): void {
    if (this.cycle.has(windowId)) this.finish(windowId, undefined);
  }

  /** The window loses focus (⌘Tab to another app): close without changing tab or taking back focus. */
  windowLeft(windowId: WindowId): void {
    if (this.cycle.has(windowId)) this.finish(windowId, undefined, false);
  }

  /** At each new state: tab usage, tabs removed from the cycles, vanished windows. */
  onState(state: BrowserState): void {
    const present = new Set(state.windows.map((f) => f.id));
    for (const f of state.windows) {
      const active = f.active[f.activeSpace] ?? null;
      if (this.actives.get(f.id) !== active) {
        this.actives.set(f.id, active);
        if (active) {
          this.histories.set(f.id, noteUsage(this.histories.get(f.id) ?? [], active));
          this.captures.schedule(f.id);
        }
      }
    }
    for (const [f, h] of this.histories) {
      if (!present.has(f)) this.histories.delete(f);
      else if (h.some((id) => !state.tabs[id])) this.histories.set(f, h.filter((id) => !!state.tabs[id]));
    }
    for (const f of this.actives.keys()) {
      if (!present.has(f)) {
        this.actives.delete(f);
        this.captures.forget(f);
      }
    }
    for (const [f, c] of this.cycle) {
      // Closed, moved to another window or outside the displayed space: the tab leaves the cycle.
      const allowed = new Set(present.has(f) ? walkableTabs(state, f) : []);
      let p: Walk | null = c.p;
      for (const id of c.p.list) if (p && !allowed.has(id)) p = remove(p, id);
      if (p === c.p) continue;
      if (!p) this.finish(f, undefined);
      else {
        c.p = p;
        if (c.visible) this.sendPanel(f, c);
      }
    }
  }

  /** `focus`: give the keyboard back to the displayed page if the panel had taken it, once the tab has changed. */
  private finish(windowId: WindowId, enable: TabId | undefined, focus = true): void {
    const c = this.cycle.get(windowId);
    if (!c) return;
    clearTimeout(c.timeout);
    this.cycle.delete(windowId);
    if (c.visible) this.o.send(windowId, null);
    if (enable) this.o.dispatch(this.activation(windowId, enable));
    if (c.visible && focus) this.o.restoreFocus(windowId);
  }

  /**
   * Like the sidebar: an essential opens through its favorite, which shows it in the displayed space (its tab may
   * belong to a sibling space with the same key, which activerOnglet would make active instead).
   */
  private activation(windowId: WindowId, id: TabId): Action {
    const link = this.o.state().tabs[id]?.link;
    return link?.type === "essentiel" ? { type: "ouvrirFavori", windowId: windowId, kind: "essentiel", id: link.id } : { type: "activerOnglet", id };
  }

  private sendPanel(windowId: WindowId, c: InProgress): void {
    const state = this.o.state();
    const { start: start, end: end } = visibleWindow(c.p);
    const cards = c.p.list.slice(start, end).map((id) => {
      const o = state.tabs[id];
      return { id, title: o?.title ?? "", favicon: o?.favicon ?? null, preview: this.o.preview(id) };
    });
    this.o.send(windowId, { cards: cards, selection: c.p.selection - start });
  }
}
