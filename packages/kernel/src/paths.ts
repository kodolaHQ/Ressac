import { homedir } from "node:os";
import { dirname, join, relative, isAbsolute } from "node:path";

export const CONTAINER_PATH = "/workspace";

export interface SpacePaths {
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

export function spacePaths(root?: string): SpacePaths {
  const r = root ?? process.env.WEBAIOS_RACINE ?? join(homedir(), "WebAiOs");
  const home = join(r, "accueil");
  const internal = join(r, ".webaios");
  return {
    racine: r,
    accueil: home,
    blocs: join(home, "blocs"),
    widgets: join(home, "widgets"),
    disposition: join(home, "disposition.json"),
    projets: join(r, "projets"),
    interne: internal,
    profils: join(internal, "profils"),
    configMcp: join(internal, "mcp.json"),
    journaux: join(internal, "journaux"),
    extensions: join(r, "extensions"),
    actions: join(r, "actions"),
    composants: join(r, "composants"),
    sites: join(r, "sites"),
  };
}

/** Folder of the MCP configs specific to agent sessions (next to `configMcp`). */
export function sessionsFolder(c: SpacePaths): string {
  return join(dirname(c.configMcp), "sessions");
}

/** MCP config specific to the agent session of a window (`<configMcp folder>/sessions/<session>.json`). */
export function sessionConfigPath(c: SpacePaths, session: string): string {
  return join(sessionsFolder(c), `${session}.json`);
}

/** Translates a workspace path on the Mac into a path in the container. */
export function pathInContainer(hostPath: string, c: SpacePaths): string {
  const rel = relative(c.racine, hostPath);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Chemin hors de l'espace : ${hostPath}`);
  }
  return rel === "" ? CONTAINER_PATH : `${CONTAINER_PATH}/${rel.split("\\").join("/")}`;
}
