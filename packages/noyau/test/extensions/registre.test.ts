import { describe, it, expect } from "vitest";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ERREUR_PROFIL_PRIVE,
  activer,
  appliquerProfilsPrives,
  chargeesDans,
  cleExtension,
  couperTout,
  desactiver,
  desactiverPartout,
  epingler,
  lireCle,
  lireEtatExtensions,
  modifierEtatExtensions,
  retirer,
  retirerProfil,
  type EntreeExtension,
  type EtatExtensions,
} from "../../src/extensions/registre.js";
import type { Portee } from "../../src/extensions/manifeste.js";
import { dossierTemporaire } from "../aide/temporaire.js";

const portee: Portee = { permissions: [], hotes: [], reseau: [], tousLesSites: false, scriptsTousLesSites: false };
const entree = (source: "store" | "agent", surcharge: Partial<EntreeExtension> = {}): EntreeExtension => ({
  source,
  idChrome: null,
  nom: "X",
  version: "1.0",
  accord: portee,
  profils: [],
  epinglee: false,
  modifieeLe: null,
  desactivee: null,
  majEnAttente: null,
  vues: {},
  ...surcharge,
});
const A = "agent:mon-ext";
const S = "store:" + "a".repeat(32);
const etat = (extensions: Record<string, EntreeExtension>, toutesCoupees = false): EtatExtensions => ({
  version: 1,
  toutesCoupees,
  extensions,
});
const aucun = new Set<string>();

describe("registre des extensions", () => {
  it("activer une extension de l'agent dans un profil privé lève ERREUR_PROFIL_PRIVE ; une extension du Store y est activée", () => {
    const e = etat({ [A]: entree("agent"), [S]: entree("store") });
    const prives = new Set(["p"]);
    expect(() => activer(e, A, "p", prives)).toThrow(ERREUR_PROFIL_PRIVE);
    expect(activer(e, S, "p", prives).extensions[S]!.profils).toEqual(["p"]);
    expect(e.extensions[S]!.profils).toEqual([]);
    const deux = activer(activer(e, A, "q", aucun), A, "q", aucun);
    expect(deux.extensions[A]!.profils).toEqual(["q"]);
  });

  it("activer sans accord lève", () => {
    const e = etat({ [A]: entree("agent", { accord: null }) });
    expect(() => activer(e, A, "p", aucun)).toThrow();
    expect(() => activer(e, "store:" + "b".repeat(32), "p", aucun)).toThrow();
  });

  it("appliquerProfilsPrives retire seulement les extensions de l'agent, et les liste", () => {
    const e = etat({
      [A]: entree("agent", { profils: ["p", "q"], vues: { p: "1", q: "1" } }),
      [S]: entree("store", { profils: ["p"] }),
    });
    const r = appliquerProfilsPrives(e, new Set(["p"]));
    expect(r.etat.extensions[A]!.profils).toEqual(["q"]);
    expect(r.etat.extensions[S]!.profils).toEqual(["p"]);
    expect(r.retirees).toEqual([{ cle: A, profil: "p" }]);
  });

  it("chargeesDans : rien quand toutesCoupees, rien pour une extension désactivée", () => {
    const desactivee = { raison: "plantages" as const, le: "2026-01-01T00:00:00Z" };
    const e = etat({
      [A]: entree("agent", { profils: ["p"] }),
      [S]: entree("store", { profils: ["p"], desactivee }),
      ["store:" + "c".repeat(32)]: entree("store", { profils: ["p"], accord: null }),
      ["store:" + "d".repeat(32)]: entree("store", { profils: ["q"] }),
    });
    expect(chargeesDans(e, "p", false)).toEqual([A]);
    expect(chargeesDans(couperTout(e, true), "p", false)).toEqual([]);
    expect(chargeesDans(couperTout(couperTout(e, true), false), "p", false)).toEqual([A]);
  });

  it("chargeesDans : un profil privé ne charge jamais d'extension de l'agent", () => {
    const e = etat({ [A]: entree("agent", { profils: ["p"] }), [S]: entree("store", { profils: ["p"] }) });
    expect(chargeesDans(e, "p", true)).toEqual([S]);
  });

  it("retirerProfil oublie profils et vues", () => {
    const e = etat({ [A]: entree("agent", { profils: ["p", "q"], vues: { p: "1", q: "2" } }) });
    const r = retirerProfil(e, "p").extensions[A]!;
    expect(r.profils).toEqual(["q"]);
    expect(r.vues).toEqual({ q: "2" });
  });

  it("desactiver, desactiverPartout, retirer, epingler", () => {
    const e = etat({ [A]: entree("agent", { profils: ["p", "q"] }) });
    expect(desactiver(e, A, "p").extensions[A]!.profils).toEqual(["q"]);
    expect(desactiverPartout(e, A).extensions[A]!.profils).toEqual([]);
    expect(retirer(e, A).extensions).toEqual({});
    expect(epingler(e, A, true).extensions[A]!.epinglee).toBe(true);
    expect(e.extensions[A]!.epinglee).toBe(false);
    expect(() => epingler(e, "agent:inconnue", true)).toThrow();
  });

  it("lireCle refuse « store:abc », « agent:A », « autre:x »", () => {
    expect(lireCle("store:abc")).toBeNull();
    expect(lireCle("agent:A")).toBeNull();
    expect(lireCle("autre:x")).toBeNull();
    expect(lireCle("agent:" + "a".repeat(41))).toBeNull();
    expect(lireCle(S)).toEqual({ source: "store", id: "a".repeat(32) });
    expect(lireCle(A)).toEqual({ source: "agent", id: "mon-ext" });
    expect(cleExtension("agent", "mon-ext")).toBe(A);
    expect(() => cleExtension("store", "abc")).toThrow();
  });
});

describe("fichier etat.json", () => {
  it("deux modifications simultanées gardent les deux changements", async () => {
    const dossier = await dossierTemporaire();
    const ajouter = (cle: string) =>
      modifierEtatExtensions(dossier, (e) => ({ ...e, extensions: { ...e.extensions, [cle]: entree("agent") } }));
    await Promise.all([ajouter("agent:a"), ajouter("agent:b"), ajouter("agent:c")]);
    const lu = await lireEtatExtensions(dossier);
    expect(Object.keys(lu.extensions).sort()).toEqual(["agent:a", "agent:b", "agent:c"]);
  });

  it("un etat.json abîmé se lit vide et n'est pas réécrit tant que rien ne change", async () => {
    const dossier = await dossierTemporaire();
    await writeFile(join(dossier, "etat.json"), "{pas du json");
    expect(await lireEtatExtensions(dossier)).toEqual({ version: 1, toutesCoupees: false, extensions: {} });
    expect(await readFile(join(dossier, "etat.json"), "utf8")).toBe("{pas du json");
    expect(await lireEtatExtensions(join(dossier, "absent"))).toEqual({ version: 1, toutesCoupees: false, extensions: {} });
  });

  it("une entrée à clé ou forme invalide est ignorée, une portée avec scripts se conserve", async () => {
    const dossier = await dossierTemporaire();
    const bonne = entree("agent", { accord: { ...portee, scripts: true } });
    await writeFile(
      join(dossier, "etat.json"),
      JSON.stringify({ version: 1, toutesCoupees: true, extensions: { [A]: bonne, "agent:BAD": bonne, "agent:x": { nom: 1 } } }),
    );
    const lu = await lireEtatExtensions(dossier);
    expect(lu.toutesCoupees).toBe(true);
    expect(Object.keys(lu.extensions)).toEqual([A]);
    expect(lu.extensions[A]!.accord?.scripts).toBe(true);
  });

  const ecrit = (dossier: string, contenu: string) => writeFile(join(dossier, "etat.json"), contenu);
  const sauvegardes = async (dossier: string) => (await readdir(dossier)).filter((f) => f.startsWith("etat.json.abime-"));
  const ajout = (cle: string) => (e: EtatExtensions) => ({ ...e, extensions: { ...e.extensions, [cle]: entree("agent") } });

  it("un fichier de version 2 se lit vide et toute écriture est refusée, sans toucher au fichier", async () => {
    const dossier = await dossierTemporaire();
    const original = JSON.stringify({ version: 2, toutesCoupees: false, extensions: { [A]: entree("agent") } });
    await ecrit(dossier, original);
    expect(await lireEtatExtensions(dossier)).toEqual({ version: 1, toutesCoupees: false, extensions: {} });
    await expect(modifierEtatExtensions(dossier, ajout("agent:b"))).rejects.toThrow(
      "état des extensions d'une version plus récente",
    );
    expect(await readFile(join(dossier, "etat.json"), "utf8")).toBe(original);
    expect(await sauvegardes(dossier)).toEqual([]);
  });

  it("écrire après un fichier abîmé garde une copie des octets d'origine", async () => {
    const dossier = await dossierTemporaire();
    await ecrit(dossier, "{pas du json");
    await modifierEtatExtensions(dossier, ajout("agent:b"));
    const copies = await sauvegardes(dossier);
    expect(copies).toHaveLength(1);
    expect(await readFile(join(dossier, copies[0]!), "utf8")).toBe("{pas du json");
    await modifierEtatExtensions(dossier, ajout("agent:c"));
    expect(await sauvegardes(dossier)).toHaveLength(1);
  });

  it("écrire après des entrées ignorées garde une copie du fichier d'origine", async () => {
    const dossier = await dossierTemporaire();
    const original = JSON.stringify({ version: 1, toutesCoupees: false, extensions: { [A]: entree("agent"), "agent:x": { nom: 1 } } });
    await ecrit(dossier, original);
    await modifierEtatExtensions(dossier, (e) => e);
    const copies = await sauvegardes(dossier);
    expect(copies).toHaveLength(1);
    expect(await readFile(join(dossier, copies[0]!), "utf8")).toBe(original);
  });

  it("seul ENOENT se lit vide : une autre erreur de lecture lève", async () => {
    const dossier = await dossierTemporaire();
    await mkdir(join(dossier, "etat.json"));
    await expect(lireEtatExtensions(dossier)).rejects.toThrow();
    await expect(modifierEtatExtensions(dossier, ajout("agent:b"))).rejects.toThrow();
  });

  it("un temporaire résiduel est ignoré", async () => {
    const dossier = await dossierTemporaire();
    await ecrit(dossier, JSON.stringify(etat({ [A]: entree("agent") })));
    await writeFile(join(dossier, "etat.json.xyz.tmp"), "reste");
    const lu = await modifierEtatExtensions(dossier, ajout("agent:b"));
    expect(Object.keys(lu.extensions).sort()).toEqual(["agent:b", A]);
    expect(await sauvegardes(dossier)).toEqual([]);
  });

  it("un changer qui lève n'empêche pas la modification suivante", async () => {
    const dossier = await dossierTemporaire();
    const rate = modifierEtatExtensions(dossier, () => {
      throw new Error("boum");
    });
    const bonne = modifierEtatExtensions(dossier, ajout("agent:b"));
    await expect(rate).rejects.toThrow("boum");
    await bonne;
    expect(Object.keys((await lireEtatExtensions(dossier)).extensions)).toEqual(["agent:b"]);
  });

  it("la confidentialité est évaluée dans la modification sérialisée", async () => {
    const dossier = await dossierTemporaire();
    await modifierEtatExtensions(dossier, ajout("agent:b"));
    await modifierEtatExtensions(dossier, (e) => ({ ...e, extensions: { ...e.extensions, "agent:b": { ...e.extensions["agent:b"]!, accord: portee } } }));
    let prive = false;
    const activation = modifierEtatExtensions(dossier, (e, prives) => activer(e, "agent:b", "p", prives), () => new Set(prive ? ["p"] : []));
    prive = true; // l'espace devient privé après l'appel mais avant l'exécution
    await expect(activation).rejects.toThrow(ERREUR_PROFIL_PRIVE);
    // activation passée par un ensemble périmé : le retrait suit quand même
    const lu = await modifierEtatExtensions(
      dossier,
      (e) => activer(e, "agent:b", "p", aucun),
      () => new Set(["p"]),
    );
    expect(lu.extensions["agent:b"]!.profils).toEqual([]);
  });
});
