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

/** Écrit la déclaration du serveur MCP du navigateur, lisible par l'agent du conteneur. */
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
 * Config d'une session d'agent. L'espace est monté en écriture dans le conteneur : l'agent peut y poser des liens
 * symboliques, donc le dossier des sessions n'est jamais suivi s'il est un lien, et le fichier est créé neuf, sans
 * suivre de lien (le jeton ne part pas ailleurs). (`mcp.json` principal suit encore un lien : dette existante.)
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
