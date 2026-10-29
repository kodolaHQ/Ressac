import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { CheminsEspace } from "../chemins.js";
import type { Profil } from "./profil.js";

/** Écrit la déclaration du serveur MCP du navigateur, lisible par l'agent du conteneur. */
export async function ecrireConfigMcp(
  c: CheminsEspace,
  format: Profil["configMcp"],
  serveur: { url: string; jeton: string },
  chemin: string = c.configMcp,
): Promise<void> {
  const contenu = {
    "claude-json": {
      mcpServers: {
        webaios: { type: "http", url: serveur.url, headers: { Authorization: `Bearer ${serveur.jeton}` } },
      },
    },
  }[format];
  await mkdir(dirname(chemin), { recursive: true });
  await writeFile(chemin, JSON.stringify(contenu, null, 2), { mode: 0o600 });
  await chmod(chemin, 0o600);
}
