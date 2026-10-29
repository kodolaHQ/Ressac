import { describe, it, expect } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
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
    expect(chargeesDans(e, "p")).toEqual([A]);
    expect(chargeesDans(couperTout(e, true), "p")).toEqual([]);
    expect(chargeesDans(couperTout(couperTout(e, true), false), "p")).toEqual([A]);
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
});
