import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { SpacePaths } from "../paths.js";

const WILDCARDS = { mcpConfig: "{mcpConfig}", prompt: "{prompt}" } as const;

export const Profile = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  interactive: z.array(z.string()).min(1),
  // Background tasks never have access to the browser's tools (spec §8.2).
  nonInteractive: z.array(z.string()).min(1).refine((a) => !a.includes(WILDCARDS.mcpConfig), {
    message: "nonInteractive ne doit pas recevoir {mcpConfig}",
  }),
  mcpConfig: z.literal("claude-json"),
});
export type Profile = z.infer<typeof Profile>;

export async function loadProfiles(
  c: SpacePaths,
): Promise<{ profiles: Profile[]; errors: { file: string; message: string }[] }> {
  const profiles: Profile[] = [];
  const errors: { file: string; message: string }[] = [];
  if (!existsSync(c.profiles)) return { profiles: profiles, errors: errors };
  for (const name of (await readdir(c.profiles)).filter((n) => n.endsWith(".json")).sort()) {
    const file = join(c.profiles, name);
    try {
      profiles.push(Profile.parse(JSON.parse(await readFile(file, "utf8"))));
    } catch (e) {
      errors.push({ file: file, message: (e as Error).message });
    }
  }
  return { profiles: profiles, errors: errors };
}

/** Builds a profile's command; each wildcard replaces a whole argument. */
export function buildCommand(
  p: Profile,
  mode: "interactive" | "nonInteractive",
  vars: { mcpConfig?: string; prompt?: string },
): string[] {
  const model = p[mode];
  if (mode === "nonInteractive" && model.includes(WILDCARDS.mcpConfig)) {
    throw new Error(`Profil ${p.id} : nonInteractive ne doit pas recevoir {mcpConfig}`);
  }
  return model.map((arg) => {
    for (const [key, wildcard] of Object.entries(WILDCARDS) as [keyof typeof WILDCARDS, string][]) {
      if (arg !== wildcard) continue;
      const value = vars[key];
      if (value === undefined) throw new Error(`Profil ${p.id} : variable ${key} manquante`);
      return value;
    }
    return arg;
  });
}
