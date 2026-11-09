import { expect, test } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spacePaths } from "../../src/paths.js";
import { loadProfiles, buildCommand, Profile } from "../../src/profiles/profile.js";
import { tempFolder } from "../helpers/temp.js";

const claude = Profile.parse(JSON.parse(await readFile(join(import.meta.dirname, "../../modeles/profil-claude.json"), "utf8")));

test("buildCommand interactif remplace {mcpConfig}", () => {
  expect(buildCommand(claude, "interactive", { mcpConfig: "/workspace/.webaios/mcp.json" })).toEqual([
    "claude", "--dangerously-skip-permissions", "--mcp-config", "/workspace/.webaios/mcp.json",
  ]);
});

test("nonInteractif: the instruction stays a single argument, even with spaces and quotes", () => {
  const instruction = `Résume "ça" ; rm -rf /`;
  const cmd = buildCommand(claude, "nonInteractive", { prompt: instruction });
  expect(cmd.at(-1)).toBe(instruction);
  expect(cmd).toHaveLength(4);
});

test("variable manquante → erreur", () => {
  expect(() => buildCommand(claude, "interactive", {})).toThrow(/mcpConfig/);
});

test("a nonInteractif profile with {mcpConfig} is refused", () => {
  const faulty = { ...claude, nonInteractive: ["x", "{mcpConfig}", "{consigne}"] };
  expect(() => buildCommand(faulty, "nonInteractive", { prompt: "c", mcpConfig: "/m" })).toThrow();
  expect(Profile.safeParse(faulty).success).toBe(false);
});

test("loadProfiles ignores an invalid profile and reports it", async () => {
  const c = spacePaths(await tempFolder());
  await mkdir(c.profiles, { recursive: true });
  await writeFile(join(c.profiles, "claude.json"), JSON.stringify(claude));
  await writeFile(join(c.profiles, "casse.json"), "{");
  await writeFile(join(c.profiles, "note.txt"), "pas un profil");
  const { profiles: profiles, errors: errors } = await loadProfiles(c);
  expect(profiles.map((p) => p.id)).toEqual(["claude"]);
  expect(errors).toHaveLength(1);
  expect(errors[0]!.file).toBe(join(c.profiles, "casse.json"));
});
