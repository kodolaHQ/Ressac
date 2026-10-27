import type { WebContents } from "electron";
import { OngletIntrouvable, type OngletInfo, type PontNavigateur } from "@webaios/noyau";
import type { Decision, DemandeEnAttente, EtatFenetre, EtatNavigateur, IdEspace, IdFenetre, Onglet } from "../../commun/modele";
import type { Magasin } from "../ipc";

const info = (etat: EtatNavigateur, o: Onglet): OngletInfo => ({
  id: o.id,
  titre: o.titre,
  url: o.url,
  espace: etat.espaces.find((e) => e.id === o.espaceId)?.nom ?? "",
});

/** Pages internes de WebAiOs (`webaios:`) : l'agent ne les voit jamais. */
const interne = (o: Onglet) => o.url.startsWith("webaios:");

/** Tous les onglets, toutes fenêtres confondues, tels que l'agent les voit. */
export function infosOnglets(etat: EtatNavigateur): OngletInfo[] {
  return Object.values(etat.onglets).filter((o) => !interne(o)).map((o) => info(etat, o));
}

export function ongletActifDe(etat: EtatNavigateur, fenetreId: IdFenetre | undefined): OngletInfo | null {
  const f = etat.fenetres.find((x) => x.id === fenetreId);
  const id = f?.actif[f.espaceActif];
  const o = id ? etat.onglets[id] : undefined;
  return o && !interne(o) ? info(etat, o) : null;
}

/** L'espace demandé par l'agent : par id, puis par nom (sans casse), sinon l'espace actif. */
export function resoudreEspace(etat: EtatNavigateur, f: EtatFenetre, espace?: string): IdEspace {
  if (!espace) return f.espaceActif;
  const e = etat.espaces.find((x) => x.id === espace) ?? etat.espaces.find((x) => x.nom.toLowerCase() === espace.toLowerCase());
  return e?.id ?? f.espaceActif;
}

/** Ce que la politique d'accès doit apprendre d'un changement d'état : navigations et fermetures. */
export function changementsPolitique(avant: EtatNavigateur, apres: EtatNavigateur): { navigues: { id: string; url: string }[]; fermes: string[] } {
  const navigues: { id: string; url: string }[] = [];
  const fermes: string[] = [];
  for (const [id, o] of Object.entries(avant.onglets)) {
    const n = apres.onglets[id];
    if (!n) fermes.push(id);
    else if (n.url !== o.url) navigues.push({ id, url: n.url });
  }
  return { navigues, fermes };
}

/**
 * Une question qui ne recevra plus de réponse utile : son onglet visé est fermé. Une demande de l'agent s'affiche
 * dans sa fenêtre, quel que soit l'onglet affiché : fermer celui-ci ne la concerne pas.
 */
export function questionCaduque(d: DemandeEnAttente, etat: EtatNavigateur): boolean {
  if (d.cible && !etat.onglets[d.cible]) return true;
  return !d.fenetreId && d.ongletId !== null && !etat.onglets[d.ongletId];
}

/** Une demande de lecture sans réponse au bout de ce délai est refusée : l'agent ne reste pas bloqué. */
export const DELAI_QUESTION_MS = 120_000;

/**
 * Pose une question à l'utilisateur et attend sa réponse. `poser` affiche la question, reçoit de quoi y répondre, et
 * renvoie de quoi la retirer (appelé si le délai expire).
 */
export function attendreReponse(poser: (repondre: (d: Decision) => void) => () => void, delaiMs = DELAI_QUESTION_MS): Promise<boolean> {
  return new Promise((ok) => {
    let finie = false;
    const repondre = (d: Decision) => {
      if (finie) return;
      finie = true;
      clearTimeout(minuterie);
      ok(d === "autoriser");
    };
    const minuterie = setTimeout(() => {
      retirer();
      repondre("refuser");
    }, delaiMs);
    const retirer = poser(repondre);
  });
}

/** Ce que le pont demande aux vues (GestionnaireVues). */
export interface VuesPourAgent {
  naviguer(id: string, url: string): void;
  lireTexte(o: Onglet): Promise<{ texte: string; selection?: string }>;
  capturer(o: Onglet): Promise<Buffer>;
  lireTexteDe(wc: WebContents): Promise<{ texte: string; selection?: string }>;
  capturerDe(wc: WebContents): Promise<Buffer>;
}

/** Les fenêtres des applications lancées, vues comme des onglets `app:<dossier>`. */
export interface FenetresPourAgent {
  ouvertes(): { dossier: string; titre: string; url: string }[];
  webContents(dossier: string): WebContents | undefined;
}

const PREFIXE_APP = "app:";

/** La fenêtre d'une appli vue comme un onglet `app:<dossier>` par l'agent. */
export function ongletApplication(a: { dossier: string; titre: string; url: string }): OngletInfo {
  return { id: PREFIXE_APP + a.dossier, titre: a.titre, url: a.url, espace: "", application: a.dossier };
}

/** Le navigateur Electron vu par le noyau (spec §5) : lire, ouvrir, capturer les onglets ; demander à l'utilisateur. */
export class PontElectron implements PontNavigateur {
  constructor(
    private readonly o: {
      magasin: Magasin;
      vues: VuesPourAgent;
      /** Fenêtre principale au premier plan, sinon la dernière qui l'a été. */
      fenetreActive: () => IdFenetre | undefined;
      demander: (o: OngletInfo) => Promise<boolean>;
      applications: FenetresPourAgent;
    },
  ) {}

  /** La fenêtre d'une appli si `id` est `app:<dossier>` ; undefined pour un onglet ordinaire. */
  private fenetreAppli(id: string): WebContents | undefined {
    if (!id.startsWith(PREFIXE_APP)) return undefined;
    const wc = this.o.applications.webContents(id.slice(PREFIXE_APP.length));
    if (!wc) throw new OngletIntrouvable(id);
    return wc;
  }

  private onglet(id: string): Onglet {
    const o = this.o.magasin.etat.onglets[id];
    if (!o) throw new OngletIntrouvable(id);
    return o;
  }

  async ongletActif(): Promise<OngletInfo | null> {
    return ongletActifDe(this.o.magasin.etat, this.o.fenetreActive());
  }

  async listerOnglets(): Promise<OngletInfo[]> {
    const apps = this.o.applications.ouvertes().map(ongletApplication);
    return [...infosOnglets(this.o.magasin.etat), ...apps];
  }

  async lireTexte(id: string): Promise<{ texte: string; selection?: string }> {
    const wc = this.fenetreAppli(id);
    return wc ? this.o.vues.lireTexteDe(wc) : this.o.vues.lireTexte(this.onglet(id));
  }

  /** Les démos de l'agent s'ouvrent au premier plan, marquées ✦ (spec §6). */
  async ouvrirOnglet(url: string, espace?: string): Promise<OngletInfo> {
    const etat = this.o.magasin.etat;
    const f = etat.fenetres.find((x) => x.id === this.o.fenetreActive()) ?? etat.fenetres[0];
    if (!f) throw new Error("Aucune fenêtre ouverte");
    const avant = new Set(Object.keys(etat.onglets));
    this.o.magasin.agir({ type: "ouvrirOnglet", fenetreId: f.id, url, espaceId: resoudreEspace(etat, f, espace), activer: true, ouvertParAgent: true });
    const nouveau = Object.values(this.o.magasin.etat.onglets).find((o) => !avant.has(o.id));
    if (!nouveau) throw new Error(`Impossible d'ouvrir ${url}`);
    this.o.magasin.agir({ type: "activerOnglet", id: nouveau.id }); // passe aussi dans son espace
    return info(this.o.magasin.etat, nouveau);
  }

  async naviguer(id: string, url: string): Promise<void> {
    const wc = this.fenetreAppli(id);
    if (wc) {
      void wc.loadURL(url).catch(() => {});
      return;
    }
    this.onglet(id);
    this.o.vues.naviguer(id, url);
  }

  async capturer(id: string): Promise<Buffer> {
    const wc = this.fenetreAppli(id);
    return wc ? this.o.vues.capturerDe(wc) : this.o.vues.capturer(this.onglet(id));
  }

  demanderAutorisation(o: OngletInfo): Promise<boolean> {
    return this.o.demander(o);
  }
}
