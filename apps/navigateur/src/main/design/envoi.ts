import { cheminDansConteneur, prefixeRemarques, type CheminsEspace, type IdProjet, type Lot, type ProjetSuivi } from "@webaios/noyau";
import type { IdFenetre } from "../../commun/modele";

export interface OptionsEnvoi {
  chemins: CheminsEspace;
  /** La fenêtre principale que l'agent considère comme active. */
  fenetreAgent(): IdFenetre | undefined;
  dossierLot(p: IdProjet, lot: string): string;
  /** `agent.preRemplir` : ouvre le panneau et met le texte dans la saisie, sans l'envoyer. */
  preRemplir(f: IdFenetre, texte: string): void;
  /** Comme ⌘J : le terminal de l'agent prend le clavier. */
  donnerLeTerminal(f: IdFenetre): void;
  /** La fenêtre principale passe devant (sans effet en mode invisible). */
  devant(f: IdFenetre): void;
  /** Aucune fenêtre principale : en rouvrir une (comme la page Relecture), qui reçoit le texte. */
  rouvrir?(): void;
}

/** Aucune fenêtre principale, même rouverte : le lot est écrit, mais rien n'a pu être pré-rempli. */
export const AUCUNE_FENETRE = "Aucune fenêtre principale pour l'agent : le lot est enregistré, rouvre une fenêtre pour le lui donner.";

/**
 * Après l'écriture d'un lot : pour un lot de l'agent (appli, démo), une ligne est pré-remplie dans sa session, jamais
 * envoyée. Un projet externe n'a rien de plus : son lot est déjà dans la file du Claude Code branché.
 */
export function creerEnvoi(o: OptionsEnvoi): (p: ProjetSuivi, lot: Lot) => Promise<void> {
  return async (p, lot) => {
    if (p.type === "externe") return;
    let f = o.fenetreAgent();
    if (f === undefined) {
      o.rouvrir?.();
      f = o.fenetreAgent();
    }
    if (f === undefined) throw new Error(AUCUNE_FENETRE);
    const cheminLot = cheminDansConteneur(o.dossierLot(lot.projet, lot.id), o.chemins);
    const projet =
      p.type === "app" ? ({ type: "app", nom: p.nom, dossier: p.dossier } as const)
      : p.type === "site" ? ({ type: "site", nom: p.nom, id: p.id } as const)
      : ({ type: "demo", port: p.port } as const);
    o.preRemplir(f, prefixeRemarques({ projet, lot, cheminLot }));
    o.donnerLeTerminal(f);
    o.devant(f);
  };
}
