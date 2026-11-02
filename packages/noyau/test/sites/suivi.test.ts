import { expect, test } from "vitest";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { adresseDeDepart, domainesEffectifs } from "../../src/sites/adresses.js";
import { accorderSite, lireAccordsSites } from "../../src/sites/accords.js";
import { MemoireSite } from "../../src/sites/memoire.js";
import type { DeclarationSite } from "../../src/sites/schemas.js";
import { changerAdresse, lireEtatAdresse, supprimerDonneesSite } from "../../src/sites/suivi.js";
import { dossierTemporaire } from "../aide/temporaire.js";

const decl: DeclarationSite = {
  nom: "Vidola", description: "", adresse: "https://www.vidola-a.example/film?x=1", domaines: ["vidola-a.example"],
  connexion: [], retouches: [], reprise: true,
};
const existe = (p: string) => stat(p).then(() => true, () => false);

test("changerAdresse a → b : anciens [a] ; puis c : anciens [a, b]", async () => {
  const d = await dossierTemporaire();
  expect(await lireEtatAdresse(d, "w")).toBeNull();
  const e1 = await changerAdresse(d, "w", decl, "vidola-b.example");
  expect(e1).toMatchObject({ actuel: "vidola-b.example", anciens: ["www.vidola-a.example"] });
  expect(e1.depuis).not.toBeNull();
  const e2 = await changerAdresse(d, "w", decl, "vidola-c.example");
  expect(e2.anciens).toEqual(["www.vidola-a.example", "vidola-b.example"]);
  expect(await lireEtatAdresse(d, "w")).toEqual(e2);
  // revenir à un ancien : plus dans anciens ; pas de doublon
  const e3 = await changerAdresse(d, "w", decl, "VIDOLA-B.example.");
  expect(e3.actuel).toBe("vidola-b.example");
  expect(e3.anciens).toEqual(["www.vidola-a.example", "vidola-c.example"]);
  await expect(changerAdresse(d, "w", decl, "pas valide/")).rejects.toThrow();
});

test("domainesEffectifs les réunit avec ceux de site.json", async () => {
  const d = await dossierTemporaire();
  const e = await changerAdresse(d, "w", { ...decl, adresse: "https://vidola-a.example/" }, "vidola-b.example");
  expect(domainesEffectifs(decl, e)).toEqual(["vidola-a.example", "vidola-b.example"]);
});

test("adresseDeDepart garde chemin et requête sur le domaine actuel", async () => {
  const d = await dossierTemporaire();
  const e = await changerAdresse(d, "w", decl, "vidola-b.example");
  expect(adresseDeDepart(decl, e)).toBe("https://vidola-b.example/film?x=1");
});

test("supprimerDonneesSite efface mémoire, adresse et accord de ce seul site", async () => {
  const p = await dossierTemporaire();
  const ds = join(p, "sites");
  for (const id of ["a", "b"]) {
    const m = await MemoireSite.ouvrir(ds, id);
    m.retenir("k", 1, null);
    await m.vider();
    await changerAdresse(ds, id, decl, "vidola-b.example");
    await accorderSite(p, id, decl);
  }
  await supprimerDonneesSite(p, "a");
  expect(await existe(join(ds, "a", "memoire.json"))).toBe(false);
  expect(await lireEtatAdresse(ds, "a")).toBeNull();
  expect(Object.keys(await lireAccordsSites(p))).toEqual(["b"]);
  expect(await existe(join(ds, "b", "memoire.json"))).toBe(true);
  expect(await lireEtatAdresse(ds, "b")).not.toBeNull();
  await mkdir(ds, { recursive: true });
  await writeFile(join(ds, "x"), "");
  await expect(supprimerDonneesSite(p, "../b")).rejects.toThrow();
});

test("supprimerDonneesSite retire tout le dossier, .bak compris", async () => {
  const p = await dossierTemporaire();
  const ds = join(p, "sites");
  await mkdir(join(ds, "a"), { recursive: true });
  await writeFile(join(ds, "a", "memoire.json.bak"), "x");
  await supprimerDonneesSite(p, "a");
  expect(await existe(join(ds, "a"))).toBe(false);
});

test("changerAdresse garde les 100 anciens les plus récents", async () => {
  const d = await dossierTemporaire();
  let e = await changerAdresse(d, "w", decl, "s0.example");
  for (let i = 1; i <= 105; i++) e = await changerAdresse(d, "w", decl, `s${i}.example`);
  expect(e.anciens).toHaveLength(100);
  expect(e.anciens.at(-1)).toBe("s104.example");
  expect(await lireEtatAdresse(d, "w")).toEqual(e);
});

test("une suppression ordonnée après un changerAdresse en vol laisse le site effacé", async () => {
  const p = await dossierTemporaire();
  const ds = join(p, "sites");
  const c = changerAdresse(ds, "w", decl, "vidola-b.example");
  await supprimerDonneesSite(p, "w");
  await c;
  expect(await lireEtatAdresse(ds, "w")).toBeNull();
});
