import type { Action, MessageParcours, PanneauOnglets } from "../commun/api";
import type { EtatNavigateur, IdFenetre, IdOnglet } from "../commun/modele";
import { creerRegroupeur } from "./onglets/regroupeur";
import { avancer, demarrer, fenetreVisible, noterUtilisation, ongletsParcourables, ordreRecent, retirer, type Parcours } from "./recents";

/** Le panneau n'apparaît que si ⌃ est encore enfoncé après ce délai (un aller-retour rapide ne le fait pas clignoter). */
const DELAI_PANNEAU_MS = 200;
/** Capture de l'onglet devenu actif, après coup : elle ne retarde jamais le changement d'onglet. */
const DELAI_CAPTURE_MS = 1000;

interface EnCours {
  p: Parcours;
  minuteur: ReturnType<typeof setTimeout> | undefined;
  /** Le panneau a été envoyé à l'interface (il faudra lui envoyer null). */
  visible: boolean;
}

/**
 * ⌃Tab façon Zen, côté process principal : ordre d'utilisation récente par fenêtre, parcours tant que ⌃ est enfoncé,
 * onglet activé seulement au relâchement de ⌃ (ou à un clic dans le panneau).
 */
export class ParcoursOnglets {
  /** Onglets utilisés, du plus récent au plus ancien, par fenêtre. */
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
      /** Rend le clavier à la page affichée dans la fenêtre (l'interface l'a pris pour la capture du fond du panneau). */
      rendreFocus(fenetreId: IdFenetre): void;
      /**
       * La fenêtre principale a le focus. Sinon (outils de développement détachés…), le relâchement de ⌃ n'y arriverait
       * jamais et la fenêtre ne perdrait pas le focus : un parcours y resterait bloqué.
       */
      estFocalisee(fenetreId: IdFenetre): boolean;
      delaiMs?: number;
    },
  ) {
    this.delaiMs = o.delaiMs ?? DELAI_PANNEAU_MS;
    this.captures = creerRegroupeur(DELAI_CAPTURE_MS, (f) => void this.o.capturer(f).catch(() => {}));
  }

  /** ⌃Tab (1) ou ⌃⇧Tab (-1) depuis le menu. */
  parcourir(fenetreId: IdFenetre, delta: 1 | -1): void {
    const courant = this.parcours.get(fenetreId);
    if (courant) {
      courant.p = avancer(courant.p, delta);
      if (courant.visible) this.envoyerPanneau(fenetreId, courant);
      return;
    }
    const p = demarrer(ordreRecent(this.o.etat(), fenetreId, this.historiques.get(fenetreId) ?? []), delta);
    if (!p) return;
    // Fenêtre sans le focus : bascule immédiate, comme un appui bref, sans parcours ni panneau.
    if (!this.o.estFocalisee(fenetreId)) return this.o.agir(this.activation(fenetreId, p.liste[p.selection]!));
    const enCours: EnCours = { p, minuteur: undefined, visible: false };
    this.parcours.set(fenetreId, enCours);
    // L'onglet affiché a pu changer depuis sa dernière capture : sa carte doit être à jour.
    void this.o.capturer(fenetreId).catch(() => {});
    enCours.minuteur = setTimeout(() => {
      enCours.minuteur = undefined;
      if (this.parcours.get(fenetreId) !== enCours) return;
      enCours.visible = true;
      this.envoyerPanneau(fenetreId, enCours);
    }, this.delaiMs);
  }

  /** ⌃ relâché dans la fenêtre (interface ou page) : active la sélection. Sans effet hors parcours. */
  toucheRelachee(fenetreId: IdFenetre): void {
    const c = this.parcours.get(fenetreId);
    if (c) this.terminer(fenetreId, c.p.liste[c.p.selection]);
  }

  /** Message du panneau (déjà validé par zod). */
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

  /** Échap : fermer sans changer d'onglet. */
  annuler(fenetreId: IdFenetre): void {
    if (this.parcours.has(fenetreId)) this.terminer(fenetreId, undefined);
  }

  /** La fenêtre perd le focus (⌘Tab vers une autre appli) : fermer sans changer d'onglet ni reprendre le focus. */
  fenetreQuittee(fenetreId: IdFenetre): void {
    if (this.parcours.has(fenetreId)) this.terminer(fenetreId, undefined, false);
  }

  /** À chaque nouvel état : utilisation des onglets, onglets sortis des parcours, fenêtres disparues. */
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
      // Fermé, parti dans une autre fenêtre ou hors de l'espace affiché : l'onglet sort du parcours.
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

  /** `focus` : rendre le clavier à la page affichée si le panneau l'avait pris, une fois l'onglet changé. */
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
   * Comme la barre latérale : un essentiel s'ouvre par son favori, qui le montre dans l'espace affiché (son onglet peut
   * appartenir à un espace frère de même clé, qu'activerOnglet rendrait actif à la place).
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
