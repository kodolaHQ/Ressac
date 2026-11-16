import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { KERNEL_ROOT, type SpacePaths } from "../paths.js";

const WILDCARDS = { mcpConfig: "{mcpConfig}", prompt: "{prompt}" } as const;

export const Profile = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  interactive: z.array(z.string()).min(1),
  // Background tasks never have access to the browser's tools (spec §8.2).
  nonInteractive: z.array(z.string()).min(1).refine((a) => !a.includes(WILDCARDS.mcpConfig), {
    message: "nonInteractive ne doit pas recevoir {mcpConfig}",
  }),
  resume: z.array(z.string()).min(1).optional(),
  mcpConfig: z.enum(["claude-json", "codex-toml"]),
});
export type Profile = z.infer<typeof Profile>;

/** The shipped profiles, read from the templates and never from the space (the agent could write `.ressac` before 0.1.8). */
export const SHIPPED_PROFILES: Readonly<Record<string, string>> = { claude: "agent-profile.json", codex: "codex-profile.json" };

export async function loadProfiles(
  c: SpacePaths,
  models: string = join(KERNEL_ROOT, "templates"),
): Promise<{ profiles: Profile[]; errors: { file: string; message: string }[] }> {
  const profiles: Profile[] = [];
  const errors: { file: string; message: string }[] = [];
  const parse = async (file: string) => {
    try {
      profiles.push(Profile.parse(JSON.parse(await readFile(file, "utf8"))));
    } catch (e) {
      errors.push({ file: file, message: (e as Error).message });
    }
  };
  for (const name of Object.values(SHIPPED_PROFILES)) await parse(join(models, name));
  const shipped = profiles.length;
  if (existsSync(c.profiles)) {
    for (const e of (await readdir(c.profiles, { withFileTypes: true })).filter((e) => e.name.endsWith(".json"))) {
      // Regular files only: a link may lead into the writable workspace.
      if (e.isFile()) await parse(join(c.profiles, e.name));
    }
  }
  // A space file never stands in for a shipped profile (old copies of claude.json and codex.json are left there).
  const custom = profiles.splice(shipped).filter((p) => !(p.id in SHIPPED_PROFILES));
  return { profiles: [...profiles, ...custom].sort((a, b) => a.id.localeCompare(b.id)), errors: errors };
}

/** Builds a profile's command; each wildcard replaces a whole argument. */
export function buildCommand(
  p: Profile,
  mode: "interactive" | "resume" | "nonInteractive",
  vars: { mcpConfig?: string; prompt?: string },
): string[] {
  const model = p[mode];
  if (!model) throw new Error(`Profil ${p.id} : pas de commande ${mode}`);
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
