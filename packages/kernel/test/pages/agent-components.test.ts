import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readAgentComponents } from "../../src/pages/agent-components.js";

let dossier: string;
beforeEach(async () => { dossier = await mkdtemp(join(tmpdir(), "composants-")); });
afterEach(async () => { await rm(dossier, { recursive: true, force: true }); });

const decl = (name: string, plus: object = {}) =>
  JSON.stringify({ nom: name, description: "Barres", proprietes: { donnees: { genre: "reference", description: "Les données", requis: true } }, ...plus });
async function write(name: string, json: string | null, html: string | null) {
  await mkdir(join(dossier, name), { recursive: true });
  if (json !== null) await writeFile(join(dossier, name, "composant.json"), json);
  if (html !== null) await writeFile(join(dossier, name, "composant.html"), html);
}

describe("lireComposantsAgent", () => {
  it("graphique-barres (composant.json + composant.html) is valid", async () => {
    await write("graphique-barres", decl("graphique-barres"), "<svg></svg>");
    const r = await readAgentComponents(dossier);
    expect(r.invalides).toEqual([]);
    expect(r.valides).toHaveLength(1);
    expect(r.valides[0]).toMatchObject({ nom: "graphique-barres", origine: "agent" });
    expect(r.valides[0]!.proprietes.donnees).toMatchObject({ genre: "reference", requis: true });
  });

  it("composant.html absent : invalide « composant.html absent »", async () => {
    await write("sans-html", decl("sans-html"), null);
    const r = await readAgentComponents(dossier);
    expect(r.valides).toEqual([]);
    expect(r.invalides).toEqual([{ nom: "sans-html", erreur: "composant.html absent" }]);
  });

  it("name different from the folder, name « tableau », kind « fonction », 300 KB html, symbolic link: invalid with a readable error", async () => {
    await write("autre", decl("pas-autre"), "<p></p>");
    await write("tableau", decl("tableau"), "<p></p>");
    await write("fonc", decl("fonc", { proprietes: { f: { genre: "fonction", description: "x" } } }), "<p></p>");
    await write("gros", decl("gros"), "x".repeat(300 * 1024));
    await write("cible", decl("cible"), "<p></p>");
    await mkdir(join(dossier, "lien-dossier-cible"), { recursive: true });
    await symlink(join(dossier, "cible", "composant.html"), join(dossier, "lien-dossier-cible", "composant.html"));
    await writeFile(join(dossier, "lien-dossier-cible", "composant.json"), decl("lien-dossier-cible"));
    await symlink(join(dossier, "cible"), join(dossier, "lien"));
    const r = await readAgentComponents(dossier);
    const errors = Object.fromEntries(r.invalides.map((i) => [i.nom, i.erreur]));
    expect(errors["autre"]).toMatch(/nom/);
    expect(errors["tableau"]).toMatch(/intégré/);
    expect(errors["fonc"]).toMatch(/composant\.json invalide/);
    expect(errors["gros"]).toMatch(/256 Ko/);
    expect(errors["lien-dossier-cible"]).toMatch(/composant\.html/);
    expect(errors["lien"]).toBeUndefined();
    expect(r.valides.map((v) => v.nom)).toEqual(["cible"]);
    for (const e of Object.values(errors)) expect(e).not.toContain(dossier);
  });

  it("an invalid one does not prevent the others from being read", async () => {
    await write("a-casse", "{pas du json", "<p></p>");
    await write("b-bon", decl("b-bon"), "<p></p>");
    const r = await readAgentComponents(dossier);
    expect(r.valides.map((v) => v.nom)).toEqual(["b-bon"]);
    expect(r.invalides).toEqual([{ nom: "a-casse", erreur: "composant.json illisible (pas du JSON valide)" }]);
  });

  it("property names __proto__, with a line break, 13 properties, composant.json symbolic link: invalid", async () => {
    const prop = { genre: "texte", description: "x" };
    await write("proto", '{"nom":"proto","description":"d","proprietes":{"__proto__":{"genre":"texte","description":"x"}}}', "<p></p>");
    await write("saut", decl("saut", { proprietes: { "a\nb": prop } }), "<p></p>");
    const thirteen = Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`p${i}`, prop]));
    await write("treize", decl("treize", { proprietes: thirteen }), "<p></p>");
    await write("lj", null, "<p></p>");
    await writeFile(join(dossier, "lj", "reel.json"), decl("lj"));
    await symlink(join(dossier, "lj", "reel.json"), join(dossier, "lj", "composant.json"));
    const r = await readAgentComponents(dossier);
    expect(r.valides).toEqual([]);
    const e = Object.fromEntries(r.invalides.map((i) => [i.nom, i.erreur]));
    expect(e["proto"]).toMatch(/composant\.json invalide/);
    expect(e["saut"]).toMatch(/composant\.json invalide/);
    expect(e["treize"]).toMatch(/12 propriétés/);
    expect(e["lj"]).toBe("composant.json n'est pas un fichier ordinaire");
  });

  it("dossier introuvable : rien", async () => {
    expect(await readAgentComponents(join(dossier, "absent"))).toEqual({ valides: [], invalides: [] });
  });
});
