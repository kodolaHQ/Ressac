import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { sessionConfigPath, sessionsFolder, type SpacePaths } from "../paths.js";
import type { Profile } from "./profile.js";

function configContent(format: Profile["configMcp"], server: { url: string; jeton: string }): string {
  return JSON.stringify(
    {
      "claude-json": {
        mcpServers: {
          webaios: { type: "http", url: server.url, headers: { Authorization: `Bearer ${server.jeton}` } },
        },
      },
    }[format],
    null,
    2,
  );
}

/** Writes the browser's MCP server declaration, readable by the container's agent. */
export async function writeMcpConfig(
  c: SpacePaths,
  format: Profile["configMcp"],
  server: { url: string; jeton: string },
  path: string = c.configMcp,
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
  format: Profile["configMcp"],
  server: { url: string; jeton: string },
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
