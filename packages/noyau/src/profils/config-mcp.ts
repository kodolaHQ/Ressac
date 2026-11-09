import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { cheminConfigSession, dossierSessions, type CheminsEspace } from "../chemins.js";
import type { Profil } from "./profil.js";

function contenuConfig(format: Profil["configMcp"], serveur: { url: string; jeton: string }): string {
  return JSON.stringify(
    {
      "claude-json": {
        mcpServers: {
          webaios: { type: "http", url: serveur.url, headers: { Authorization: `Bearer ${serveur.jeton}` } },
        },
      },
    }[format],
    null,
    2,
  );
}

/** Writes the browser's MCP server declaration, readable by the container's agent. */
export async function ecrireConfigMcp(
  c: CheminsEspace,
  format: Profil["configMcp"],
  serveur: { url: string; jeton: string },
  chemin: string = c.configMcp,
): Promise<void> {
  await mkdir(dirname(chemin), { recursive: true });
  await writeFile(chemin, contenuConfig(format, serveur), { mode: 0o600 });
  await chmod(chemin, 0o600);
}

/**
 * Config of an agent session. The workspace is mounted writable in the container: the agent can put symbolic
 * links in it, so the sessions folder is never followed if it is a link, and the file is created new, without
 * following a link (the token does not go elsewhere). (The main `mcp.json` still follows a link: existing debt.)
 */
export async function ecrireConfigSession(
  c: CheminsEspace,
  format: Profil["configMcp"],
  serveur: { url: string; jeton: string },
  session: string,
): Promise<void> {
  const dossier = dossierSessions(c);
  await mkdir(dirname(dossier), { recursive: true });
  const info = await lstat(dossier).catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT") return null;
    throw e;
  });
  if (!info) await mkdir(dossier, { mode: 0o700 });
  else if (!info.isDirectory()) throw new Error(`Dossier des sessions invalide (lien ou fichier) : ${dossier}`);
  const f = await open(cheminConfigSession(c, session), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    await f.writeFile(contenuConfig(format, serveur));
  } finally {
    await f.close();
  }
}
