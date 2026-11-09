import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readAgentComponents } from "../../src/pages/agent-components.js";

let folder: string;
beforeEach(async () => { folder = await mkdtemp(join(tmpdir(), "composants-")); });
afterEach(async () => { await rm(folder, { recursive: true, force: true }); });

const decl = (name: string, extra: object = {}) =>
  JSON.stringify({ name: name, description: "Barres", properties: { data: { kind: "reference", description: "Les données", required: true } }, ...extra });
async function write(name: string, json: string | null, html: string | null) {
  await mkdir(join(folder, name), { recursive: true });
  if (json !== null) await writeFile(join(folder, name, "component.json"), json);
  if (html !== null) await writeFile(join(folder, name, "component.html"), html);
}

describe("readAgentComponents", () => {
  it("graphique-barres (component.json + component.html) is valid", async () => {
    await write("graphique-barres", decl("graphique-barres"), "<svg></svg>");
    const r = await readAgentComponents(folder);
    expect(r.invalids).toEqual([]);
    expect(r.valid).toHaveLength(1);
    expect(r.valid[0]).toMatchObject({ name: "graphique-barres", origin: "agent" });
    expect(r.valid[0]!.properties.data).toMatchObject({ kind: "reference", required: true });
  });

  it("component.html absent : invalide « component.html absent »", async () => {
    await write("sans-html", decl("sans-html"), null);
    const r = await readAgentComponents(folder);
    expect(r.valid).toEqual([]);
    expect(r.invalids).toEqual([{ name: "sans-html", error: "component.html absent" }]);
  });

  it("name different from the folder, name « table », kind « fonction », 300 KB html, symbolic link: invalid with a readable error", async () => {
    await write("other", decl("not-other"), "<p></p>");
    await write("table", decl("table"), "<p></p>");
    await write("fonc", decl("fonc", { properties: { f: { kind: "fonction", description: "x" } } }), "<p></p>");
    await write("big", decl("big"), "x".repeat(300 * 1024));
    await write("cible", decl("cible"), "<p></p>");
    await mkdir(join(folder, "lien-dossier-cible"), { recursive: true });
    await symlink(join(folder, "cible", "component.html"), join(folder, "lien-dossier-cible", "component.html"));
    await writeFile(join(folder, "lien-dossier-cible", "component.json"), decl("lien-dossier-cible"));
    await symlink(join(folder, "cible"), join(folder, "link"));
    const r = await readAgentComponents(folder);
    const errors = Object.fromEntries(r.invalids.map((i) => [i.name, i.error]));
    expect(errors["other"]).toMatch(/nom/);
    expect(errors["table"]).toMatch(/intégré/);
    expect(errors["fonc"]).toMatch(/component\.json invalide/);
    expect(errors["big"]).toMatch(/256 Ko/);
    expect(errors["lien-dossier-cible"]).toMatch(/component\.html/);
    expect(errors["link"]).toBeUndefined();
    expect(r.valid.map((v) => v.name)).toEqual(["cible"]);
    for (const e of Object.values(errors)) expect(e).not.toContain(folder);
  });

  it("an invalid one does not prevent the others from being read", async () => {
    await write("a-casse", "{pas du json", "<p></p>");
    await write("b-bon", decl("b-bon"), "<p></p>");
    const r = await readAgentComponents(folder);
    expect(r.valid.map((v) => v.name)).toEqual(["b-bon"]);
    expect(r.invalids).toEqual([{ name: "a-casse", error: "component.json illisible (pas du JSON valide)" }]);
  });

  it("property names __proto__, with a line break, 13 properties, component.json symbolic link: invalid", async () => {
    const prop = { kind: "text", description: "x" };
    await write("proto", '{"name":"proto","description":"d","properties":{"__proto__":{"kind":"text","description":"x"}}}', "<p></p>");
    await write("saut", decl("saut", { properties: { "a\nb": prop } }), "<p></p>");
    const thirteen = Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`p${i}`, prop]));
    await write("treize", decl("treize", { properties: thirteen }), "<p></p>");
    await write("lj", null, "<p></p>");
    await writeFile(join(folder, "lj", "reel.json"), decl("lj"));
    await symlink(join(folder, "lj", "reel.json"), join(folder, "lj", "component.json"));
    const r = await readAgentComponents(folder);
    expect(r.valid).toEqual([]);
    const e = Object.fromEntries(r.invalids.map((i) => [i.name, i.error]));
    expect(e["proto"]).toMatch(/component\.json invalide/);
    expect(e["saut"]).toMatch(/component\.json invalide/);
    expect(e["treize"]).toMatch(/12 propriétés/);
    expect(e["lj"]).toBe("component.json n'est pas un fichier ordinaire");
  });

  it("dossier introuvable : rien", async () => {
    expect(await readAgentComponents(join(folder, "absent"))).toEqual({ valid: [], invalids: [] });
  });
});
