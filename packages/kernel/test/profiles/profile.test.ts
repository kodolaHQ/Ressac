import { expect, test } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spacePaths } from "../../src/paths.js";
import { loadProfiles, buildCommand, Profile } from "../../src/profiles/profile.js";
import { tempFolder } from "../helpers/temp.js";

const claude = Profile.parse(JSON.parse(await readFile(join(import.meta.dirname, "../../templates/agent-profile.json"), "utf8")));

test("buildCommand, interactive, replaces {mcpConfig}", () => {
  expect(buildCommand(claude, "interactive", { mcpConfig: "/workspace/.webaios/mcp.json" })).toEqual([
    "claude", "--disallowedTools", "WebSearch,WebFetch", "--dangerously-skip-permissions", "--mcp-config", "/workspace/.webaios/mcp.json",
  ]);
});

test("nonInteractive: the instruction stays a single argument, even with spaces and quotes", () => {
  const instruction = `Résume "ça" ; rm -rf /`;
  const cmd = buildCommand(claude, "nonInteractive", { prompt: instruction });
  expect(cmd.at(-1)).toBe(instruction);
  expect(cmd).toHaveLength(6);
});

test("variable manquante → erreur", () => {
  expect(() => buildCommand(claude, "interactive", {})).toThrow(/mcpConfig/);
});

test("a nonInteractive profile with {mcpConfig} is refused", () => {
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

const codex = Profile.parse(JSON.parse(await readFile(join(import.meta.dirname, "../../templates/codex-profile.json"), "utf8")));

test("a codex-toml profile with resume loads; buildCommand resume uses it", () => {
  expect(codex.mcpConfig).toBe("codex-toml");
  expect(buildCommand(codex, "resume", { mcpConfig: "X" })).toEqual(["codex", "resume", "--last", "--dangerously-bypass-approvals-and-sandbox", "-c", "X"]);
});

test("buildCommand resume without a resume command throws; an unknown mcpConfig is refused", () => {
  const { resume: _, ...without } = codex;
  expect(() => buildCommand(without, "resume", { mcpConfig: "X" })).toThrow("Profil codex : pas de commande resume");
  expect(Profile.safeParse({ ...codex, mcpConfig: "autre" }).success).toBe(false);
});

test("the shipped Claude commands hold --disallowedTools WebSearch,WebFetch as two arguments, before any wildcard", () => {
  for (const key of ["interactive", "resume", "nonInteractive"] as const) {
    const cmd = claude[key]!;
    const i = cmd.indexOf("--disallowedTools");
    expect(i, key).toBe(1);
    expect(cmd[i + 1]).toBe("WebSearch,WebFetch");
    expect(cmd.indexOf("{prompt}") === -1 || cmd.indexOf("{prompt}") > i).toBe(true);
  }
});
