import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { CheminsEspace } from "../chemins.js";
import type { Profil } from "./profil.js";

/** Écrit la déclaration du serveur MCP du navigateur, lisible par l'agent du conteneur. */
export async function ecrireConfigMcp(
  c: CheminsEspace,
  format: Profil["configMcp"],
  serveur: { url: string; jeton: string },
): Promise<void> {
  const contenu = {
    "claude-json": {
      mcpServers: {
        webaios: { type: "http", url: serveur.url, headers: { Authorization: `Bearer ${serveur.jeton}` } },
      },
    },
  }[format];
  await mkdir(dirname(c.configMcp), { recursive: true });
  await writeFile(c.configMcp, JSON.stringify(contenu, null, 2), { mode: 0o600 });
  await chmod(c.configMcp, 0o600);
}
