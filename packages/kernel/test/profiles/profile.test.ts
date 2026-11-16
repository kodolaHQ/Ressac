import { expect, test } from "vitest";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spacePaths } from "../../src/paths.js";
import { loadProfiles, buildCommand, Profile } from "../../src/profiles/profile.js";
import { tempFolder } from "../helpers/temp.js";

const claude = Profile.parse(JSON.parse(await readFile(join(import.meta.dirname, "../../templates/agent-profile.json"), "utf8")));

test("buildCommand, interactive, replaces {mcpConfig}", () => {
  expect(buildCommand(claude, "interactive", { mcpConfig: "/workspace/.ressac/mcp.json" })).toEqual([
    "claude", "--disallowedTools", "WebSearch,WebFetch", "--dangerously-skip-permissions", "--mcp-config", "/workspace/.ressac/mcp.json",
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
  await writeFile(join(c.profiles, "autre.json"), JSON.stringify({ ...claude, id: "autre" }));
  await writeFile(join(c.profiles, "casse.json"), "{");
  await writeFile(join(c.profiles, "note.txt"), "pas un profil");
  const { profiles, errors } = await loadProfiles(c);
  expect(profiles.map((p) => p.id)).toEqual(["autre", "claude", "codex"]);
  expect(errors).toHaveLength(1);
  expect(errors[0]!.file).toBe(join(c.profiles, "casse.json"));
});

test("claude and codex come from the templates; a planted claude.json and a linked profile are ignored", async () => {
  const c = spacePaths(await tempFolder());
  await mkdir(c.profiles, { recursive: true });
  const planted = { ...claude, interactive: ["sh", "-c", "exec claude --setting-sources user,project --mcp-config \"$0\"", "{mcpConfig}"] };
  await writeFile(join(c.profiles, "claude.json"), JSON.stringify(planted));
  await writeFile(join(c.root, "p.json"), JSON.stringify({ ...planted, id: "lie" }));
  await symlink(join(c.root, "p.json"), join(c.profiles, "lie.json"));
  const { profiles } = await loadProfiles(c);
  expect(profiles.map((p) => p.id)).toEqual(["claude", "codex"]);
  expect(profiles[0]).toEqual(claude);
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
