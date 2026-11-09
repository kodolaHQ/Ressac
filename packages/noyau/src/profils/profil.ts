import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { CheminsEspace } from "../chemins.js";

const JOKERS = { mcpConfig: "{mcpConfig}", consigne: "{consigne}" } as const;

export const Profil = z.object({
  id: z.string().min(1),
  nom: z.string().min(1),
  interactif: z.array(z.string()).min(1),
  // Background tasks never have access to the browser's tools (spec §8.2).
  nonInteractif: z.array(z.string()).min(1).refine((a) => !a.includes(JOKERS.mcpConfig), {
    message: "nonInteractif ne doit pas recevoir {mcpConfig}",
  }),
  configMcp: z.literal("claude-json"),
});
export type Profil = z.infer<typeof Profil>;

export async function chargerProfils(
  c: CheminsEspace,
): Promise<{ profils: Profil[]; erreurs: { fichier: string; message: string }[] }> {
  const profils: Profil[] = [];
  const erreurs: { fichier: string; message: string }[] = [];
  if (!existsSync(c.profils)) return { profils, erreurs };
  for (const nom of (await readdir(c.profils)).filter((n) => n.endsWith(".json")).sort()) {
    const fichier = join(c.profils, nom);
    try {
      profils.push(Profil.parse(JSON.parse(await readFile(fichier, "utf8"))));
    } catch (e) {
      erreurs.push({ fichier, message: (e as Error).message });
    }
  }
  return { profils, erreurs };
}

/** Builds a profile's command; each wildcard replaces a whole argument. */
export function construireCommande(
  p: Profil,
  mode: "interactif" | "nonInteractif",
  vars: { mcpConfig?: string; consigne?: string },
): string[] {
  const modele = p[mode];
  if (mode === "nonInteractif" && modele.includes(JOKERS.mcpConfig)) {
    throw new Error(`Profil ${p.id} : nonInteractif ne doit pas recevoir {mcpConfig}`);
  }
  return modele.map((arg) => {
    for (const [cle, joker] of Object.entries(JOKERS) as [keyof typeof JOKERS, string][]) {
      if (arg !== joker) continue;
      const valeur = vars[cle];
      if (valeur === undefined) throw new Error(`Profil ${p.id} : variable ${cle} manquante`);
      return valeur;
    }
    return arg;
  });
}
