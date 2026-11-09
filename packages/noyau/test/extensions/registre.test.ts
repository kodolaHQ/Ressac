import { describe, it, expect } from "vitest";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ERREUR_PROFIL_PRIVE,
  activer,
  appliquerProfilsPrives,
  cleExtension,
  couperTout,
  desactiver,
  desactiverPartout,
  epingler,
  lireCle,
  lireEtatExtensions,
  modifierEtatExtensions,
  retirer,
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

describe("extension registry", () => {
  it("enabling an agent extension in a private profile throws ERREUR_PROFIL_PRIVE; a Store extension is enabled there", () => {
    const e = etat({ [A]: entree("agent"), [S]: entree("store") });
    const prives = new Set(["p"]);
    expect(() => activer(e, A, "p", prives)).toThrow(ERREUR_PROFIL_PRIVE);
    expect(activer(e, S, "p", prives).extensions[S]!.profils).toEqual(["p"]);
    expect(e.extensions[S]!.profils).toEqual([]);
    const deux = activer(activer(e, A, "q", aucun), A, "q", aucun);
    expect(deux.extensions[A]!.profils).toEqual(["q"]);
  });

  it("enabling without a grant throws", () => {
    const e = etat({ [A]: entree("agent", { accord: null }) });
    expect(() => activer(e, A, "p", aucun)).toThrow();
    expect(() => activer(e, "store:" + "b".repeat(32), "p", aucun)).toThrow();
  });

  it("appliquerProfilsPrives removes only the agent's extensions, and lists them", () => {
    const e = etat({
      [A]: entree("agent", { profils: ["p", "q"], vues: { p: "1", q: "1" } }),
      [S]: entree("store", { profils: ["p"] }),
    });
    const r = appliquerProfilsPrives(e, new Set(["p"]));
    expect(r.etat.extensions[A]!.profils).toEqual(["q"]);
    expect(r.etat.extensions[S]!.profils).toEqual(["p"]);
    expect(r.retirees).toEqual([{ cle: A, profil: "p" }]);
  });

  it("desactiver, desactiverPartout, retirer, couperTout, epingler", () => {
    const e = etat({ [A]: entree("agent", { profils: ["p", "q"] }) });
    expect(desactiver(e, A, "p").extensions[A]!.profils).toEqual(["q"]);
    expect(desactiverPartout(e, A).extensions[A]!.profils).toEqual([]);
    expect(retirer(e, A).extensions).toEqual({});
    expect(couperTout(e, true).toutesCoupees).toBe(true);
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
  it("two simultaneous modifications keep both changes", async () => {
    const dossier = await dossierTemporaire();
    const ajouter = (cle: string) =>
      modifierEtatExtensions(dossier, (e) => ({ ...e, extensions: { ...e.extensions, [cle]: entree("agent") } }), () => aucun);
    await Promise.all([ajouter("agent:a"), ajouter("agent:b"), ajouter("agent:c")]);
    const lu = await lireEtatExtensions(dossier);
    expect(Object.keys(lu.extensions).sort()).toEqual(["agent:a", "agent:b", "agent:c"]);
  });

  it("a damaged etat.json reads as empty and is not rewritten as long as nothing changes", async () => {
    const dossier = await dossierTemporaire();
    await writeFile(join(dossier, "etat.json"), "{pas du json");
    expect(await lireEtatExtensions(dossier)).toEqual({ version: 1, toutesCoupees: false, extensions: {} });
    expect(await readFile(join(dossier, "etat.json"), "utf8")).toBe("{pas du json");
    expect(await lireEtatExtensions(join(dossier, "absent"))).toEqual({ version: 1, toutesCoupees: false, extensions: {} });
  });

  it("an entry with an invalid key or shape is ignored, a scope with scripts is kept", async () => {
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

  it("consolesMasquees (Chromium ids masked from the agent) survives retirer and the re-read; an invalid id is ignored", async () => {
    const dossier = await dossierTemporaire();
    const id = "b".repeat(32);
    await writeFile(
      join(dossier, "etat.json"),
      JSON.stringify({ version: 1, toutesCoupees: false, extensions: { [A]: entree("agent") }, consolesMasquees: [id, "pas-un-id", 3, "garde@agent.webaios", "garde@autre.org"] }),
    );
    const lu = await lireEtatExtensions(dossier);
    expect(lu.consolesMasquees).toEqual([id, "garde@agent.webaios"]);
    expect(retirer(lu, A).consolesMasquees).toEqual([id, "garde@agent.webaios"]);
    await modifierEtatExtensions(dossier, (e) => retirer(e, A), () => aucun);
    const relu = await lireEtatExtensions(dossier);
    expect(relu.extensions).toEqual({});
    expect(relu.consolesMasquees).toEqual([id, "garde@agent.webaios"]);
  });

  const ecrit = (dossier: string, contenu: string) => writeFile(join(dossier, "etat.json"), contenu);
  const sauvegardes = async (dossier: string) => (await readdir(dossier)).filter((f) => f.startsWith("etat.json.abime-"));
  const ajout = (cle: string) => (e: EtatExtensions) => ({ ...e, extensions: { ...e.extensions, [cle]: entree("agent") } });
  const sansPrive = () => aucun;

  it("a version 2 file reads as empty and any write is refused, without touching the file", async () => {
    const dossier = await dossierTemporaire();
    const original = JSON.stringify({ version: 2, toutesCoupees: false, extensions: { [A]: entree("agent") } });
    await ecrit(dossier, original);
    expect(await lireEtatExtensions(dossier)).toEqual({ version: 1, toutesCoupees: false, extensions: {} });
    await expect(modifierEtatExtensions(dossier, ajout("agent:b"), sansPrive)).rejects.toThrow(
      "état des extensions d'une version plus récente",
    );
    expect(await readFile(join(dossier, "etat.json"), "utf8")).toBe(original);
    expect(await sauvegardes(dossier)).toEqual([]);
  });

  it("writing after a damaged file keeps a copy of the original bytes", async () => {
    const dossier = await dossierTemporaire();
    await ecrit(dossier, "{pas du json");
    await modifierEtatExtensions(dossier, ajout("agent:b"), sansPrive);
    const copies = await sauvegardes(dossier);
    expect(copies).toHaveLength(1);
    expect(await readFile(join(dossier, copies[0]!), "utf8")).toBe("{pas du json");
    await modifierEtatExtensions(dossier, ajout("agent:c"), sansPrive);
    expect(await sauvegardes(dossier)).toHaveLength(1);
  });

  it("writing after ignored entries keeps a copy of the original file", async () => {
    const dossier = await dossierTemporaire();
    const original = JSON.stringify({ version: 1, toutesCoupees: false, extensions: { [A]: entree("agent"), "agent:x": { nom: 1 } } });
    await ecrit(dossier, original);
    await modifierEtatExtensions(dossier, (e) => e, sansPrive);
    const copies = await sauvegardes(dossier);
    expect(copies).toHaveLength(1);
    expect(await readFile(join(dossier, copies[0]!), "utf8")).toBe(original);
  });

  it("only ENOENT reads as empty: another read error throws", async () => {
    const dossier = await dossierTemporaire();
    await mkdir(join(dossier, "etat.json"));
    await expect(lireEtatExtensions(dossier)).rejects.toThrow();
    await expect(modifierEtatExtensions(dossier, ajout("agent:b"), sansPrive)).rejects.toThrow();
  });

  it("a leftover temporary is ignored", async () => {
    const dossier = await dossierTemporaire();
    await ecrit(dossier, JSON.stringify(etat({ [A]: entree("agent") })));
    await writeFile(join(dossier, "etat.json.xyz.tmp"), "reste");
    const lu = await modifierEtatExtensions(dossier, ajout("agent:b"), sansPrive);
    expect(Object.keys(lu.extensions).sort()).toEqual(["agent:b", A]);
    expect(await sauvegardes(dossier)).toEqual([]);
  });

  it("a changer that throws does not prevent the next modification", async () => {
    const dossier = await dossierTemporaire();
    const rate = modifierEtatExtensions(dossier, () => {
      throw new Error("boum");
    }, sansPrive);
    const bonne = modifierEtatExtensions(dossier, ajout("agent:b"), sansPrive);
    await expect(rate).rejects.toThrow("boum");
    await bonne;
    expect(Object.keys((await lireEtatExtensions(dossier)).extensions)).toEqual(["agent:b"]);
  });

  it("confidentiality is evaluated within the serialized modification", async () => {
    const dossier = await dossierTemporaire();
    await modifierEtatExtensions(dossier, ajout("agent:b"), sansPrive);
    await modifierEtatExtensions(dossier, (e) => ({ ...e, extensions: { ...e.extensions, "agent:b": { ...e.extensions["agent:b"]!, accord: portee } } }), sansPrive);
    let prive = false;
    const activation = modifierEtatExtensions(dossier, (e, prives) => activer(e, "agent:b", "p", prives), () => new Set(prive ? ["p"] : []));
    prive = true; // the space becomes private after the call but before the execution
    await expect(activation).rejects.toThrow(ERREUR_PROFIL_PRIVE);
    // activation passed through a stale set: the removal follows anyway
    const lu = await modifierEtatExtensions(
      dossier,
      (e) => activer(e, "agent:b", "p", aucun),
      () => new Set(["p"]),
    );
    expect(lu.extensions["agent:b"]!.profils).toEqual([]);
  });

  it("applis survives modifierEtatExtensions and the re-read; an etat.json without applis re-reads without an .abime-* copy", async () => {
    const dossier = await dossierTemporaire();
    await mkdir(dossier, { recursive: true });
    await writeFile(join(dossier, "etat.json"), JSON.stringify(etat({ [S]: entree("store") })));
    expect((await lireEtatExtensions(dossier)).extensions[S]!.applis).toBeUndefined();
    await modifierEtatExtensions(dossier, (e) => e, () => aucun);
    expect((await readdir(dossier)).filter((f) => f.includes(".abime-"))).toEqual([]);
    await modifierEtatExtensions(dossier, (e) => ({ ...e, extensions: { ...e.extensions, [S]: { ...e.extensions[S]!, applis: { vidola: "e1" } } } }), () => aucun);
    expect((await lireEtatExtensions(dossier)).extensions[S]!.applis).toEqual({ vidola: "e1" });
    await modifierEtatExtensions(dossier, (e) => e, () => aucun);
    expect((await lireEtatExtensions(dossier)).extensions[S]!.applis).toEqual({ vidola: "e1" });
    expect((await readdir(dossier)).filter((f) => f.includes(".abime-"))).toEqual([]);
  });
});
