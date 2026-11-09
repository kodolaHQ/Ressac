import { homedir } from "node:os";
import { dirname, join, relative, isAbsolute } from "node:path";

export const CHEMIN_CONTENEUR = "/workspace";

export interface CheminsEspace {
  racine: string;
  accueil: string;
  blocs: string;
  /** Widgets of the home page (code and display; the data is outside the workspace). */
  widgets: string;
  disposition: string;
  projets: string;
  /** Dossier interne `.webaios` (profils, config MCP). */
  interne: string;
  profils: string;
  configMcp: string;
  /** Logs of the launched applications (`<dossier>.log`). */
  journaux: string;
  /** Extensions written by the agent (`<dossier>/manifest.json`); nothing found there grants a right. */
  extensions: string;
  /** Actions (`<dossier>/action.json`, workflow.json); their data, results and grants are outside the workspace. */
  actions: string;
  /** Page components written by the agent (`<dossier>/composant.json`). */
  composants: string;
  /** Site apps written by the agent (`<id>/site.json`, `accueil/`, `retouches/`); WebAiOs never writes there. */
  sites: string;
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
    extensions: join(r, "extensions"),
    actions: join(r, "actions"),
    composants: join(r, "composants"),
    sites: join(r, "sites"),
  };
}

/** Folder of the MCP configs specific to agent sessions (next to `configMcp`). */
export function dossierSessions(c: CheminsEspace): string {
  return join(dirname(c.configMcp), "sessions");
}

/** MCP config specific to the agent session of a window (`<configMcp folder>/sessions/<session>.json`). */
export function cheminConfigSession(c: CheminsEspace, session: string): string {
  return join(dossierSessions(c), `${session}.json`);
}

/** Translates a workspace path on the Mac into a path in the container. */
export function cheminDansConteneur(cheminHote: string, c: CheminsEspace): string {
  const rel = relative(c.racine, cheminHote);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Chemin hors de l'espace : ${cheminHote}`);
  }
  return rel === "" ? CHEMIN_CONTENEUR : `${CHEMIN_CONTENEUR}/${rel.split("\\").join("/")}`;
}
