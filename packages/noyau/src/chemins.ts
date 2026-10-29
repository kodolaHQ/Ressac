import { homedir } from "node:os";
import { dirname, join, relative, isAbsolute } from "node:path";

export const CHEMIN_CONTENEUR = "/workspace";

export interface CheminsEspace {
  racine: string;
  accueil: string;
  blocs: string;
  /** Widgets de la page d'accueil (code et affichage ; les données sont hors de l'espace). */
  widgets: string;
  disposition: string;
  projets: string;
  /** Dossier interne `.webaios` (profils, config MCP). */
  interne: string;
  profils: string;
  configMcp: string;
  /** Journaux des applications lancées (`<dossier>.log`). */
  journaux: string;
}

export function cheminsEspace(racine?: string): CheminsEspace {
  const r = racine ?? process.env.WEBAIOS_RACINE ?? join(homedir(), "WebAiOs");
  const accueil = join(r, "accueil");
  const interne = join(r, ".webaios");
  return {
    racine: r,
    accueil,
    blocs: join(accueil, "blocs"),
    widgets: join(accueil, "widgets"),
    disposition: join(accueil, "disposition.json"),
    projets: join(r, "projets"),
    interne,
    profils: join(interne, "profils"),
    configMcp: join(interne, "mcp.json"),
    journaux: join(interne, "journaux"),
  };
}

/** Config MCP propre à la session d'agent d'une fenêtre (`<dossier de configMcp>/sessions/<session>.json`). */
export function cheminConfigSession(c: CheminsEspace, session: string): string {
  return join(dirname(c.configMcp), "sessions", `${session}.json`);
}

/** Traduit un chemin de l'espace sur le Mac en chemin dans le conteneur. */
export function cheminDansConteneur(cheminHote: string, c: CheminsEspace): string {
  const rel = relative(c.racine, cheminHote);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Chemin hors de l'espace : ${cheminHote}`);
  }
  return rel === "" ? CHEMIN_CONTENEUR : `${CHEMIN_CONTENEUR}/${rel.split("\\").join("/")}`;
}
