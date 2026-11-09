import type { Action, TabCycleMessage, TabsPanel } from "../shared/api";
import type { BrowserState, WindowId, TabId } from "../shared/modele";
import { createGrouper } from "./onglets/regroupeur";
import { walkableTabs } from "../shared/onglets-parcourables";
import { advance, start, visibleWindow, noteUsage, recentOrder, retirer, type Walk } from "./recents";

/** The panel appears only if ⌃ is still held after this delay (a quick back-and-forth does not make it blink). */
const PANEL_DELAY_MS = 200;
/** Capture of the tab that became active, after the fact: it never delays the tab change. */
const CAPTURE_DELAY_MS = 1000;

interface EnCours {
  p: Walk;
  minuteur: ReturnType<typeof setTimeout> | undefined;
  /** The panel was sent to the UI (null will have to be sent to it). */
  visible: boolean;
}

/**
 * ⌃Tab Zen-style, main process side: most-recently-used order per window, cycling while ⌃ is held,
 * tab activated only on ⌃ release (or on a click in the panel).
 */
export class TabCycle {
  /** Tabs used, from most to least recent, per window. */
  private historiques = new Map<WindowId, TabId[]>();
  private actifs = new Map<WindowId, TabId | null>();
  private parcours = new Map<WindowId, EnCours>();
  private readonly delaiMs: number;
  private captures: ReturnType<typeof createGrouper>;

  constructor(
    private readonly o: {
      etat(): BrowserState;
      agir(a: Action): void;
      envoyer(windowId: WindowId, p: TabsPanel | null): void;
      apercu(id: TabId): string | null;
      capturer(windowId: WindowId): Promise<void>;
      /** Gives the keyboard back to the page displayed in the window (the UI took it to capture the panel's background). */
      rendreFocus(windowId: WindowId): void;
      /**
       * The main window has focus. Otherwise (detached developer tools…), the release of ⌃ would never reach it
       * and the window would not lose focus: a cycle would stay stuck there.
       */
      estFocalisee(windowId: WindowId): boolean;
      delaiMs?: number;
    },
  ) {
    this.delaiMs = o.delaiMs ?? PANEL_DELAY_MS;
    this.captures = createGrouper(CAPTURE_DELAY_MS, (f) => void this.o.capturer(f).catch(() => {}));
  }

  /** ⌃Tab (1) or ⌃⇧Tab (-1) from the menu. */
  parcourir(windowId: WindowId, delta: 1 | -1): void {
    const courant = this.parcours.get(windowId);
    if (courant) {
      courant.p = advance(courant.p, delta);
      if (courant.visible) this.envoyerPanneau(windowId, courant);
      return;
    }
    const p = start(recentOrder(this.o.etat(), windowId, this.historiques.get(windowId) ?? []), delta);
    if (!p) return;
    // Window without focus: immediate switch, like a brief press, without cycle or panel.
    if (!this.o.estFocalisee(windowId)) return this.o.agir(this.activation(windowId, p.liste[p.selection]!));
    const enCours: EnCours = { p, minuteur: undefined, visible: false };
    this.parcours.set(windowId, enCours);
    // The displayed tab may have changed since its last capture: its card must be up to date.
    void this.o.capturer(windowId).catch(() => {});
    enCours.minuteur = setTimeout(() => {
      enCours.minuteur = undefined;
      if (this.parcours.get(windowId) !== enCours) return;
      enCours.visible = true;
      this.envoyerPanneau(windowId, enCours);
    }, this.delaiMs);
  }

  /** ⌃ released in the window (UI or page): activates the selection. No effect outside a cycle. */
  toucheRelachee(windowId: WindowId): void {
    const c = this.parcours.get(windowId);
    if (c) this.terminer(windowId, c.p.liste[c.p.selection]);
  }

  /** Message from the panel (already validated by zod). */
  message(windowId: WindowId, m: TabCycleMessage): void {
    const c = this.parcours.get(windowId);
    if (!c) return;
    switch (m.type) {
      case "valider":
        return this.toucheRelachee(windowId);
      case "annuler":
        return this.annuler(windowId);
      case "choisir":
        if (c.p.liste.includes(m.id)) this.terminer(windowId, m.id);
        return;
      case "survoler": {
        const i = c.p.liste.indexOf(m.id);
        if (i < 0 || i === c.p.selection) return;
        c.p = { ...c.p, selection: i };
        if (c.visible) this.envoyerPanneau(windowId, c);
        return;
      }
      case "avancer":
        return this.parcourir(windowId, m.delta);
    }
  }

  /** Esc: close without changing tab. */
  annuler(windowId: WindowId): void {
    if (this.parcours.has(windowId)) this.terminer(windowId, undefined);
  }

  /** The window loses focus (⌘Tab to another app): close without changing tab or taking back focus. */
  fenetreQuittee(windowId: WindowId): void {
    if (this.parcours.has(windowId)) this.terminer(windowId, undefined, false);
  }

  /** At each new state: tab usage, tabs removed from the cycles, vanished windows. */
  surEtat(state: BrowserState): void {
    const present = new Set(state.fenetres.map((f) => f.id));
    for (const f of state.fenetres) {
      const active = f.actif[f.espaceActif] ?? null;
      if (this.actifs.get(f.id) !== active) {
        this.actifs.set(f.id, active);
        if (active) {
          this.historiques.set(f.id, noteUsage(this.historiques.get(f.id) ?? [], active));
          this.captures.planifier(f.id);
        }
      }
    }
    for (const [f, h] of this.historiques) {
      if (!present.has(f)) this.historiques.delete(f);
      else if (h.some((id) => !state.onglets[id])) this.historiques.set(f, h.filter((id) => !!state.onglets[id]));
    }
    for (const f of this.actifs.keys()) {
      if (!present.has(f)) {
        this.actifs.delete(f);
        this.captures.oublier(f);
      }
    }
    for (const [f, c] of this.parcours) {
      // Closed, moved to another window or outside the displayed space: the tab leaves the cycle.
      const allowed = new Set(present.has(f) ? walkableTabs(state, f) : []);
      let p: Walk | null = c.p;
      for (const id of c.p.liste) if (p && !allowed.has(id)) p = retirer(p, id);
      if (p === c.p) continue;
      if (!p) this.terminer(f, undefined);
      else {
        c.p = p;
        if (c.visible) this.envoyerPanneau(f, c);
      }
    }
  }

  /** `focus`: give the keyboard back to the displayed page if the panel had taken it, once the tab has changed. */
  private terminer(windowId: WindowId, enable: TabId | undefined, focus = true): void {
    const c = this.parcours.get(windowId);
    if (!c) return;
    clearTimeout(c.minuteur);
    this.parcours.delete(windowId);
    if (c.visible) this.o.envoyer(windowId, null);
    if (enable) this.o.agir(this.activation(windowId, enable));
    if (c.visible && focus) this.o.rendreFocus(windowId);
  }

  /**
   * Like the sidebar: an essential opens through its favorite, which shows it in the displayed space (its tab may
   * belong to a sibling space with the same key, which activerOnglet would make active instead).
   */
  private activation(windowId: WindowId, id: TabId): Action {
    const lien = this.o.etat().onglets[id]?.lien;
    return lien?.type === "essentiel" ? { type: "ouvrirFavori", fenetreId: windowId, genre: "essentiel", id: lien.id } : { type: "activerOnglet", id };
  }

  private envoyerPanneau(windowId: WindowId, c: EnCours): void {
    const state = this.o.etat();
    const { debut, fin } = visibleWindow(c.p);
    const cartes = c.p.liste.slice(debut, fin).map((id) => {
      const o = state.onglets[id];
      return { id, titre: o?.titre ?? "", favicon: o?.favicon ?? null, apercu: this.o.apercu(id) };
    });
    this.o.envoyer(windowId, { cartes, selection: c.p.selection - debut });
  }
}
