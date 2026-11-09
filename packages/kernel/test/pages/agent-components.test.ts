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
  if (json !== null) await writeFile(join(folder, name, "composant.json"), json);
  if (html !== null) await writeFile(join(folder, name, "composant.html"), html);
}

describe("readAgentComponents", () => {
  it("graphique-barres (composant.json + composant.html) is valid", async () => {
    await write("graphique-barres", decl("graphique-barres"), "<svg></svg>");
    const r = await readAgentComponents(folder);
    expect(r.invalids).toEqual([]);
    expect(r.valid).toHaveLength(1);
    expect(r.valid[0]).toMatchObject({ name: "graphique-barres", origin: "agent" });
    expect(r.valid[0]!.properties.donnees).toMatchObject({ kind: "reference", required: true });
  });

  it("composant.html absent : invalide « composant.html absent »", async () => {
    await write("sans-html", decl("sans-html"), null);
    const r = await readAgentComponents(folder);
    expect(r.valid).toEqual([]);
    expect(r.invalids).toEqual([{ name: "sans-html", error: "composant.html absent" }]);
  });

  it("name different from the folder, name « tableau », kind « fonction », 300 KB html, symbolic link: invalid with a readable error", async () => {
    await write("autre", decl("pas-autre"), "<p></p>");
    await write("tableau", decl("tableau"), "<p></p>");
    await write("fonc", decl("fonc", { properties: { f: { kind: "fonction", description: "x" } } }), "<p></p>");
    await write("gros", decl("gros"), "x".repeat(300 * 1024));
    await write("cible", decl("cible"), "<p></p>");
    await mkdir(join(folder, "lien-dossier-cible"), { recursive: true });
    await symlink(join(folder, "cible", "composant.html"), join(folder, "lien-dossier-cible", "composant.html"));
    await writeFile(join(folder, "lien-dossier-cible", "composant.json"), decl("lien-dossier-cible"));
    await symlink(join(folder, "cible"), join(folder, "lien"));
    const r = await readAgentComponents(folder);
    const errors = Object.fromEntries(r.invalids.map((i) => [i.name, i.error]));
    expect(errors["other"]).toMatch(/nom/);
    expect(errors["table"]).toMatch(/intégré/);
    expect(errors["fonc"]).toMatch(/composant\.json invalide/);
    expect(errors["big"]).toMatch(/256 Ko/);
    expect(errors["lien-dossier-cible"]).toMatch(/composant\.html/);
    expect(errors["link"]).toBeUndefined();
    expect(r.valid.map((v) => v.name)).toEqual(["cible"]);
    for (const e of Object.values(errors)) expect(e).not.toContain(folder);
  });

  it("an invalid one does not prevent the others from being read", async () => {
    await write("a-casse", "{pas du json", "<p></p>");
    await write("b-bon", decl("b-bon"), "<p></p>");
    const r = await readAgentComponents(folder);
    expect(r.valid.map((v) => v.name)).toEqual(["b-bon"]);
    expect(r.invalids).toEqual([{ name: "a-casse", error: "composant.json illisible (pas du JSON valide)" }]);
  });

  it("property names __proto__, with a line break, 13 properties, composant.json symbolic link: invalid", async () => {
    const prop = { kind: "texte", description: "x" };
    await write("proto", '{"nom":"proto","description":"d","proprietes":{"__proto__":{"genre":"texte","description":"x"}}}', "<p></p>");
    await write("saut", decl("saut", { properties: { "a\nb": prop } }), "<p></p>");
    const thirteen = Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`p${i}`, prop]));
    await write("treize", decl("treize", { properties: thirteen }), "<p></p>");
    await write("lj", null, "<p></p>");
    await writeFile(join(folder, "lj", "reel.json"), decl("lj"));
    await symlink(join(folder, "lj", "reel.json"), join(folder, "lj", "composant.json"));
    const r = await readAgentComponents(folder);
    expect(r.valid).toEqual([]);
    const e = Object.fromEntries(r.invalids.map((i) => [i.name, i.error]));
    expect(e["proto"]).toMatch(/composant\.json invalide/);
    expect(e["saut"]).toMatch(/composant\.json invalide/);
    expect(e["treize"]).toMatch(/12 propriétés/);
    expect(e["lj"]).toBe("composant.json n'est pas un fichier ordinaire");
  });

  it("dossier introuvable : rien", async () => {
    expect(await readAgentComponents(join(folder, "absent"))).toEqual({ valid: [], invalids: [] });
  });
});
