import { homedir } from "node:os";
import { dirname, join, relative, isAbsolute } from "node:path";

export const CONTAINER_PATH = "/workspace";

export interface SpacePaths {
  root: string;
  home: string;
  blocks: string;
  /** Widgets of the home page (code and display; the data is outside the workspace). */
  widgets: string;
  layout: string;
  projects: string;
  /** Dossier interne `.webaios` (profils, config MCP). */
  internal: string;
  profiles: string;
  mcpConfig: string;
  /** Logs of the launched applications (`<dossier>.log`). */
  logs: string;
  /** Extensions written by the agent (`<dossier>/manifest.json`); nothing found there grants a right. */
  extensions: string;
  /** Actions (`<dossier>/action.json`, workflow.json); their data, results and grants are outside the workspace. */
  actions: string;
  /** Page components written by the agent (`<dossier>/composant.json`). */
  components: string;
  /** Site apps written by the agent (`<id>/site.json`, `accueil/`, `retouches/`); WebAiOs never writes there. */
  sites: string;
}

export function spacePaths(root?: string): SpacePaths {
  const r = root ?? process.env.WEBAIOS_RACINE ?? join(homedir(), "WebAiOs");
  const home = join(r, "accueil");
  const internal = join(r, ".webaios");
  return {
    root: r,
    home: home,
    blocks: join(home, "blocs"),
    widgets: join(home, "widgets"),
    layout: join(home, "disposition.json"),
    projects: join(r, "projets"),
    internal: internal,
    profiles: join(internal, "profils"),
    mcpConfig: join(internal, "mcp.json"),
    logs: join(internal, "journaux"),
    extensions: join(r, "extensions"),
    actions: join(r, "actions"),
    components: join(r, "composants"),
    sites: join(r, "sites"),
  };
}

/** Folder of the MCP configs specific to agent sessions (next to `configMcp`). */
export function sessionsFolder(c: SpacePaths): string {
  return join(dirname(c.mcpConfig), "sessions");
}

/** MCP config specific to the agent session of a window (`<configMcp folder>/sessions/<session>.json`). */
export function sessionConfigPath(c: SpacePaths, session: string): string {
  return join(sessionsFolder(c), `${session}.json`);
}

/** Translates a workspace path on the Mac into a path in the container. */
export function pathInContainer(hostPath: string, c: SpacePaths): string {
  const rel = relative(c.root, hostPath);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Chemin hors de l'espace : ${hostPath}`);
  }
  return rel === "" ? CONTAINER_PATH : `${CONTAINER_PATH}/${rel.split("\\").join("/")}`;
}
