import type { Action, MessageParcours, PanneauOnglets } from "../shared/api";
import type { EtatNavigateur, IdFenetre, IdOnglet } from "../shared/modele";
import { creerRegroupeur } from "./onglets/regroupeur";
import { ongletsParcourables } from "../shared/onglets-parcourables";
import { avancer, demarrer, fenetreVisible, noterUtilisation, ordreRecent, retirer, type Parcours } from "./recents";

/** The panel appears only if ⌃ is still held after this delay (a quick back-and-forth does not make it blink). */
const DELAI_PANNEAU_MS = 200;
/** Capture of the tab that became active, after the fact: it never delays the tab change. */
const DELAI_CAPTURE_MS = 1000;

interface EnCours {
  p: Parcours;
  minuteur: ReturnType<typeof setTimeout> | undefined;
  /** The panel was sent to the UI (null will have to be sent to it). */
  visible: boolean;
}

/**
 * ⌃Tab Zen-style, main process side: most-recently-used order per window, cycling while ⌃ is held,
 * tab activated only on ⌃ release (or on a click in the panel).
 */
export class ParcoursOnglets {
  /** Tabs used, from most to least recent, per window. */
  private historiques = new Map<IdFenetre, IdOnglet[]>();
  private actifs = new Map<IdFenetre, IdOnglet | null>();
  private parcours = new Map<IdFenetre, EnCours>();
  private readonly delaiMs: number;
  private captures: ReturnType<typeof creerRegroupeur>;

  constructor(
    private readonly o: {
      etat(): EtatNavigateur;
      agir(a: Action): void;
      envoyer(fenetreId: IdFenetre, p: PanneauOnglets | null): void;
      apercu(id: IdOnglet): string | null;
      capturer(fenetreId: IdFenetre): Promise<void>;
      /** Gives the keyboard back to the page displayed in the window (the UI took it to capture the panel's background). */
      rendreFocus(fenetreId: IdFenetre): void;
      /**
       * The main window has focus. Otherwise (detached developer tools…), the release of ⌃ would never reach it
       * and the window would not lose focus: a cycle would stay stuck there.
       */
      estFocalisee(fenetreId: IdFenetre): boolean;
      delaiMs?: number;
    },
  ) {
    this.delaiMs = o.delaiMs ?? DELAI_PANNEAU_MS;
    this.captures = creerRegroupeur(DELAI_CAPTURE_MS, (f) => void this.o.capturer(f).catch(() => {}));
  }

  /** ⌃Tab (1) or ⌃⇧Tab (-1) from the menu. */
  parcourir(fenetreId: IdFenetre, delta: 1 | -1): void {
    const courant = this.parcours.get(fenetreId);
    if (courant) {
      courant.p = avancer(courant.p, delta);
      if (courant.visible) this.envoyerPanneau(fenetreId, courant);
      return;
    }
    const p = demarrer(ordreRecent(this.o.etat(), fenetreId, this.historiques.get(fenetreId) ?? []), delta);
    if (!p) return;
    // Window without focus: immediate switch, like a brief press, without cycle or panel.
    if (!this.o.estFocalisee(fenetreId)) return this.o.agir(this.activation(fenetreId, p.liste[p.selection]!));
    const enCours: EnCours = { p, minuteur: undefined, visible: false };
    this.parcours.set(fenetreId, enCours);
    // The displayed tab may have changed since its last capture: its card must be up to date.
    void this.o.capturer(fenetreId).catch(() => {});
    enCours.minuteur = setTimeout(() => {
      enCours.minuteur = undefined;
      if (this.parcours.get(fenetreId) !== enCours) return;
      enCours.visible = true;
      this.envoyerPanneau(fenetreId, enCours);
    }, this.delaiMs);
  }

  /** ⌃ released in the window (UI or page): activates the selection. No effect outside a cycle. */
  toucheRelachee(fenetreId: IdFenetre): void {
    const c = this.parcours.get(fenetreId);
    if (c) this.terminer(fenetreId, c.p.liste[c.p.selection]);
  }

  /** Message from the panel (already validated by zod). */
  message(fenetreId: IdFenetre, m: MessageParcours): void {
    const c = this.parcours.get(fenetreId);
    if (!c) return;
    switch (m.type) {
      case "valider":
        return this.toucheRelachee(fenetreId);
      case "annuler":
        return this.annuler(fenetreId);
      case "choisir":
        if (c.p.liste.includes(m.id)) this.terminer(fenetreId, m.id);
        return;
      case "survoler": {
        const i = c.p.liste.indexOf(m.id);
        if (i < 0 || i === c.p.selection) return;
        c.p = { ...c.p, selection: i };
        if (c.visible) this.envoyerPanneau(fenetreId, c);
        return;
      }
      case "avancer":
        return this.parcourir(fenetreId, m.delta);
    }
  }

  /** Esc: close without changing tab. */
  annuler(fenetreId: IdFenetre): void {
    if (this.parcours.has(fenetreId)) this.terminer(fenetreId, undefined);
  }

  /** The window loses focus (⌘Tab to another app): close without changing tab or taking back focus. */
  fenetreQuittee(fenetreId: IdFenetre): void {
    if (this.parcours.has(fenetreId)) this.terminer(fenetreId, undefined, false);
  }

  /** At each new state: tab usage, tabs removed from the cycles, vanished windows. */
  surEtat(etat: EtatNavigateur): void {
    const presentes = new Set(etat.fenetres.map((f) => f.id));
    for (const f of etat.fenetres) {
      const actif = f.actif[f.espaceActif] ?? null;
      if (this.actifs.get(f.id) !== actif) {
        this.actifs.set(f.id, actif);
        if (actif) {
          this.historiques.set(f.id, noterUtilisation(this.historiques.get(f.id) ?? [], actif));
          this.captures.planifier(f.id);
        }
      }
    }
    for (const [f, h] of this.historiques) {
      if (!presentes.has(f)) this.historiques.delete(f);
      else if (h.some((id) => !etat.onglets[id])) this.historiques.set(f, h.filter((id) => !!etat.onglets[id]));
    }
    for (const f of this.actifs.keys()) {
      if (!presentes.has(f)) {
        this.actifs.delete(f);
        this.captures.oublier(f);
      }
    }
    for (const [f, c] of this.parcours) {
      // Closed, moved to another window or outside the displayed space: the tab leaves the cycle.
      const permis = new Set(presentes.has(f) ? ongletsParcourables(etat, f) : []);
      let p: Parcours | null = c.p;
      for (const id of c.p.liste) if (p && !permis.has(id)) p = retirer(p, id);
      if (p === c.p) continue;
      if (!p) this.terminer(f, undefined);
      else {
        c.p = p;
        if (c.visible) this.envoyerPanneau(f, c);
      }
    }
  }

  /** `focus`: give the keyboard back to the displayed page if the panel had taken it, once the tab has changed. */
  private terminer(fenetreId: IdFenetre, activer: IdOnglet | undefined, focus = true): void {
    const c = this.parcours.get(fenetreId);
    if (!c) return;
    clearTimeout(c.minuteur);
    this.parcours.delete(fenetreId);
    if (c.visible) this.o.envoyer(fenetreId, null);
    if (activer) this.o.agir(this.activation(fenetreId, activer));
    if (c.visible && focus) this.o.rendreFocus(fenetreId);
  }

  /**
   * Like the sidebar: an essential opens through its favorite, which shows it in the displayed space (its tab may
   * belong to a sibling space with the same key, which activerOnglet would make active instead).
   */
  private activation(fenetreId: IdFenetre, id: IdOnglet): Action {
    const lien = this.o.etat().onglets[id]?.lien;
    return lien?.type === "essentiel" ? { type: "ouvrirFavori", fenetreId, genre: "essentiel", id: lien.id } : { type: "activerOnglet", id };
  }

  private envoyerPanneau(fenetreId: IdFenetre, c: EnCours): void {
    const etat = this.o.etat();
    const { debut, fin } = fenetreVisible(c.p);
    const cartes = c.p.liste.slice(debut, fin).map((id) => {
      const o = etat.onglets[id];
      return { id, titre: o?.titre ?? "", favicon: o?.favicon ?? null, apercu: this.o.apercu(id) };
    });
    this.o.envoyer(fenetreId, { cartes, selection: c.p.selection - debut });
  }
}
