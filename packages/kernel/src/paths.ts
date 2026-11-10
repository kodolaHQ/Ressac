import { homedir } from "node:os";
import { dirname, join, relative, isAbsolute } from "node:path";

/** Kernel package root in dev; once shipped, the folder holding `templates/`, `extensions/` and `docker/`. */
export const KERNEL_ROOT = process.env.WEBAIOS_KERNEL_RESOURCES ?? join(import.meta.dirname, "..");

export const CONTAINER_PATH = "/workspace";

export interface SpacePaths {
  root: string;
  home: string;
  /** Widgets of the home page (code and display; the data is outside the workspace). */
  widgets: string;
  layout: string;
  projects: string;
  /** Internal folder `.webaios` (profiles, MCP config). */
  internal: string;
  profiles: string;
  mcpConfig: string;
  /** Logs of the launched applications (`<folder>.log`). */
  logs: string;
  /** Extensions written by the agent (`<folder>/manifest.json`); nothing found there grants a right. */
  extensions: string;
  /** Actions (`<folder>/action.json`, workflow.json); their data, results and grants are outside the workspace. */
  actions: string;
  /** Page components written by the agent (`<folder>/component.json`). */
  components: string;
  /** Site apps written by the agent (`<id>/site.json`, `home/`, `tweaks/`); WebAiOs never writes there. */
  sites: string;
}

export function spacePaths(root?: string): SpacePaths {
  const r = root ?? process.env.WEBAIOS_ROOT ?? join(homedir(), "WebAiOs");
  const home = join(r, "home");
  const internal = join(r, ".webaios");
  return {
    root: r,
    home: home,
    widgets: join(home, "widgets"),
    layout: join(home, "layout.json"),
    projects: join(r, "projects"),
    internal: internal,
    profiles: join(internal, "profiles"),
    mcpConfig: join(internal, "mcp.json"),
    logs: join(internal, "logs"),
    extensions: join(r, "extensions"),
    actions: join(r, "actions"),
    components: join(r, "components"),
    sites: join(r, "sites"),
  };
}

/** Folder of the MCP configs specific to agent sessions (next to `mcpConfig`). */
export function sessionsFolder(c: SpacePaths): string {
  return join(dirname(c.mcpConfig), "sessions");
}

/** MCP config specific to the agent session of a window (`<mcpConfig folder>/sessions/<session>.json`). */
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
