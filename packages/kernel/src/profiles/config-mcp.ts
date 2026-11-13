import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { sessionConfigPath, sessionsFolder, type SpacePaths } from "../paths.js";
import type { Profile } from "./profile.js";

/** Codex takes no file: the server is declared by a `-c` argument, and the token travels in this environment variable. */
export const MCP_TOKEN_VARIABLE = "RESSAC_MCP_TOKEN";

export function mcpArgument(server: { url: string }): string {
  return `mcp_servers.ressac={url=${JSON.stringify(server.url)},bearer_token_env_var="${MCP_TOKEN_VARIABLE}"}`;
}

function configContent(format: Profile["mcpConfig"], server: { url: string; token: string }): string {
  if (format !== "claude-json") throw new Error(`Format ${format} : pas de fichier de configuration MCP`);
  return JSON.stringify(
    { mcpServers: { ressac: { type: "http", url: server.url, headers: { Authorization: `Bearer ${server.token}` } } } },
    null,
    2,
  );
}

/** Writes the browser's MCP server declaration, readable by the container's agent. */
export async function writeMcpConfig(
  c: SpacePaths,
  format: Profile["mcpConfig"],
  server: { url: string; token: string },
  path: string = c.mcpConfig,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, configContent(format, server), { mode: 0o600 });
  await chmod(path, 0o600);
}

/**
 * Config of an agent session. The workspace is mounted writable in the container: the agent can put symbolic
 * links in it, so the sessions folder is never followed if it is a link, and the file is created new, without
 * following a link (the token does not go elsewhere). (The main `mcp.json` still follows a link: existing debt.)
 */
export async function writeSessionConfig(
  c: SpacePaths,
  format: Profile["mcpConfig"],
  server: { url: string; token: string },
  session: string,
): Promise<void> {
  const folder = sessionsFolder(c);
  await mkdir(dirname(folder), { recursive: true });
  const info = await lstat(folder).catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT") return null;
    throw e;
  });
  if (!info) await mkdir(folder, { mode: 0o700 });
  else if (!info.isDirectory()) throw new Error(`Dossier des sessions invalide (lien ou fichier) : ${folder}`);
  const f = await open(sessionConfigPath(c, session), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    await f.writeFile(configContent(format, server));
  } finally {
    await f.close();
  }
}
