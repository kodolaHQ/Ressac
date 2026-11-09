import { expect, test } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spacePaths } from "../../src/paths.js";
import { loadProfiles, buildCommand, Profile } from "../../src/profiles/profile.js";
import { tempFolder } from "../helpers/temp.js";

const claude = Profile.parse(JSON.parse(await readFile(join(import.meta.dirname, "../../modeles/profil-claude.json"), "utf8")));

test("construireCommande interactif remplace {mcpConfig}", () => {
  expect(buildCommand(claude, "interactif", { mcpConfig: "/workspace/.webaios/mcp.json" })).toEqual([
    "claude", "--dangerously-skip-permissions", "--mcp-config", "/workspace/.webaios/mcp.json",
  ]);
});

test("nonInteractif: the instruction stays a single argument, even with spaces and quotes", () => {
  const instruction = `Résume "ça" ; rm -rf /`;
  const cmd = buildCommand(claude, "nonInteractif", { consigne: instruction });
  expect(cmd.at(-1)).toBe(instruction);
  expect(cmd).toHaveLength(4);
});

test("variable manquante → erreur", () => {
  expect(() => buildCommand(claude, "interactif", {})).toThrow(/mcpConfig/);
});

test("a nonInteractif profile with {mcpConfig} is refused", () => {
  const faulty = { ...claude, nonInteractif: ["x", "{mcpConfig}", "{consigne}"] };
  expect(() => buildCommand(faulty, "nonInteractif", { consigne: "c", mcpConfig: "/m" })).toThrow();
  expect(Profile.safeParse(faulty).success).toBe(false);
});

test("chargerProfils ignores an invalid profile and reports it", async () => {
  const c = spacePaths(await tempFolder());
  await mkdir(c.profils, { recursive: true });
  await writeFile(join(c.profils, "claude.json"), JSON.stringify(claude));
  await writeFile(join(c.profils, "casse.json"), "{");
  await writeFile(join(c.profils, "note.txt"), "pas un profil");
  const { profils: profiles, erreurs: errors } = await loadProfiles(c);
  expect(profiles.map((p) => p.id)).toEqual(["claude"]);
  expect(errors).toHaveLength(1);
  expect(errors[0]!.fichier).toBe(join(c.profils, "casse.json"));
});
