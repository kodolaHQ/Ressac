import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { lireComposantsAgent } from "../../src/pages/composants-agent.js";

let dossier: string;
beforeEach(async () => { dossier = await mkdtemp(join(tmpdir(), "composants-")); });
afterEach(async () => { await rm(dossier, { recursive: true, force: true }); });

const decl = (nom: string, plus: object = {}) =>
  JSON.stringify({ nom, description: "Barres", proprietes: { donnees: { genre: "reference", description: "Les données", requis: true } }, ...plus });
async function ecrire(nom: string, json: string | null, html: string | null) {
  await mkdir(join(dossier, nom), { recursive: true });
  if (json !== null) await writeFile(join(dossier, nom, "composant.json"), json);
  if (html !== null) await writeFile(join(dossier, nom, "composant.html"), html);
}

describe("lireComposantsAgent", () => {
  it("graphique-barres (composant.json + composant.html) is valid", async () => {
    await ecrire("graphique-barres", decl("graphique-barres"), "<svg></svg>");
    const r = await lireComposantsAgent(dossier);
    expect(r.invalides).toEqual([]);
    expect(r.valides).toHaveLength(1);
    expect(r.valides[0]).toMatchObject({ nom: "graphique-barres", origine: "agent" });
    expect(r.valides[0]!.proprietes.donnees).toMatchObject({ genre: "reference", requis: true });
  });

  it("composant.html absent : invalide « composant.html absent »", async () => {
    await ecrire("sans-html", decl("sans-html"), null);
    const r = await lireComposantsAgent(dossier);
    expect(r.valides).toEqual([]);
    expect(r.invalides).toEqual([{ nom: "sans-html", erreur: "composant.html absent" }]);
  });

  it("name different from the folder, name « tableau », kind « fonction », 300 KB html, symbolic link: invalid with a readable error", async () => {
    await ecrire("autre", decl("pas-autre"), "<p></p>");
    await ecrire("tableau", decl("tableau"), "<p></p>");
    await ecrire("fonc", decl("fonc", { proprietes: { f: { genre: "fonction", description: "x" } } }), "<p></p>");
    await ecrire("gros", decl("gros"), "x".repeat(300 * 1024));
    await ecrire("cible", decl("cible"), "<p></p>");
    await mkdir(join(dossier, "lien-dossier-cible"), { recursive: true });
    await symlink(join(dossier, "cible", "composant.html"), join(dossier, "lien-dossier-cible", "composant.html"));
    await writeFile(join(dossier, "lien-dossier-cible", "composant.json"), decl("lien-dossier-cible"));
    await symlink(join(dossier, "cible"), join(dossier, "lien"));
    const r = await lireComposantsAgent(dossier);
    const erreurs = Object.fromEntries(r.invalides.map((i) => [i.nom, i.erreur]));
    expect(erreurs["autre"]).toMatch(/nom/);
    expect(erreurs["tableau"]).toMatch(/intégré/);
    expect(erreurs["fonc"]).toMatch(/composant\.json invalide/);
    expect(erreurs["gros"]).toMatch(/256 Ko/);
    expect(erreurs["lien-dossier-cible"]).toMatch(/composant\.html/);
    expect(erreurs["lien"]).toBeUndefined();
    expect(r.valides.map((v) => v.nom)).toEqual(["cible"]);
    for (const e of Object.values(erreurs)) expect(e).not.toContain(dossier);
  });

  it("an invalid one does not prevent the others from being read", async () => {
    await ecrire("a-casse", "{pas du json", "<p></p>");
    await ecrire("b-bon", decl("b-bon"), "<p></p>");
    const r = await lireComposantsAgent(dossier);
    expect(r.valides.map((v) => v.nom)).toEqual(["b-bon"]);
    expect(r.invalides).toEqual([{ nom: "a-casse", erreur: "composant.json illisible (pas du JSON valide)" }]);
  });

  it("property names __proto__, with a line break, 13 properties, composant.json symbolic link: invalid", async () => {
    const prop = { genre: "texte", description: "x" };
    await ecrire("proto", '{"nom":"proto","description":"d","proprietes":{"__proto__":{"genre":"texte","description":"x"}}}', "<p></p>");
    await ecrire("saut", decl("saut", { proprietes: { "a\nb": prop } }), "<p></p>");
    const treize = Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`p${i}`, prop]));
    await ecrire("treize", decl("treize", { proprietes: treize }), "<p></p>");
    await ecrire("lj", null, "<p></p>");
    await writeFile(join(dossier, "lj", "reel.json"), decl("lj"));
    await symlink(join(dossier, "lj", "reel.json"), join(dossier, "lj", "composant.json"));
    const r = await lireComposantsAgent(dossier);
    expect(r.valides).toEqual([]);
    const e = Object.fromEntries(r.invalides.map((i) => [i.nom, i.erreur]));
    expect(e["proto"]).toMatch(/composant\.json invalide/);
    expect(e["saut"]).toMatch(/composant\.json invalide/);
    expect(e["treize"]).toMatch(/12 propriétés/);
    expect(e["lj"]).toBe("composant.json n'est pas un fichier ordinaire");
  });

  it("dossier introuvable : rien", async () => {
    expect(await lireComposantsAgent(join(dossier, "absent"))).toEqual({ valides: [], invalides: [] });
  });
});
