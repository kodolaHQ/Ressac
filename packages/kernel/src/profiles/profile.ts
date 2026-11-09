import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { SpacePaths } from "../paths.js";

const JOKERS = { mcpConfig: "{mcpConfig}", consigne: "{consigne}" } as const;

export const Profile = z.object({
  id: z.string().min(1),
  nom: z.string().min(1),
  interactif: z.array(z.string()).min(1),
  // Background tasks never have access to the browser's tools (spec §8.2).
  nonInteractif: z.array(z.string()).min(1).refine((a) => !a.includes(JOKERS.mcpConfig), {
    message: "nonInteractif ne doit pas recevoir {mcpConfig}",
  }),
  configMcp: z.literal("claude-json"),
});
export type Profile = z.infer<typeof Profile>;

export async function loadProfiles(
  c: SpacePaths,
): Promise<{ profils: Profile[]; erreurs: { fichier: string; message: string }[] }> {
  const profiles: Profile[] = [];
  const errors: { fichier: string; message: string }[] = [];
  if (!existsSync(c.profils)) return { profils: profiles, erreurs: errors };
  for (const name of (await readdir(c.profils)).filter((n) => n.endsWith(".json")).sort()) {
    const file = join(c.profils, name);
    try {
      profiles.push(Profile.parse(JSON.parse(await readFile(file, "utf8"))));
    } catch (e) {
      errors.push({ fichier: file, message: (e as Error).message });
    }
  }
  return { profils: profiles, erreurs: errors };
}

/** Builds a profile's command; each wildcard replaces a whole argument. */
export function buildCommand(
  p: Profile,
  mode: "interactif" | "nonInteractif",
  vars: { mcpConfig?: string; consigne?: string },
): string[] {
  const model = p[mode];
  if (mode === "nonInteractif" && model.includes(JOKERS.mcpConfig)) {
    throw new Error(`Profil ${p.id} : nonInteractif ne doit pas recevoir {mcpConfig}`);
  }
  return model.map((arg) => {
    for (const [key, joker] of Object.entries(JOKERS) as [keyof typeof JOKERS, string][]) {
      if (arg !== joker) continue;
      const valeur = vars[key];
      if (valeur === undefined) throw new Error(`Profil ${p.id} : variable ${key} manquante`);
      return valeur;
    }
    return arg;
  });
}
