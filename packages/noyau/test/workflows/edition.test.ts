import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CODE_MAX_OCTETS,
  ecrireMemoire,
  empreinteParametres,
  enregistrerCode,
  enregistrerWorkflow,
  lireBrouillon,
  lireCode,
  lireMemoire,
  avecMemoire,
  workflowImplicite,
} from "../../src/index.js";

let racine: string;
let fichiers: string;
let donnees: string;
beforeEach(async () => {
  racine = await mkdtemp(join(tmpdir(), "wf-edition-"));
  fichiers = join(racine, "widget");
  donnees = join(racine, "donnees");
  await mkdir(fichiers);
  await mkdir(donnees);
  await writeFile(join(fichiers, "a.mjs"), "export default () => []");
});
afterEach(() => rm(racine, { recursive: true, force: true }));

const wf = (cle = "url", extra: Record<string, unknown> = {}) => ({
  version: 1,
  blocs: [
    { id: "a", type: "code", position: { x: 1, y: 2 }, parametres: { source: "a.mjs" } },
    { id: "n", type: "liste.nouveaux", position: { x: 3, y: 4 }, parametres: { cle } },
    { id: "s", type: "sortie", position: { x: 5, y: 6 }, parametres: { vers: "widget" } },
  ],
  liens: [{ de: "a", vers: "n" }, { de: "n", vers: "s" }],
  ...extra,
});
const enreg = (brut: unknown) => enregistrerWorkflow({ dossierFichiers: fichiers, dossierDonnees: donnees, brut });
const lireJson = async () => JSON.parse(await readFile(join(fichiers, "workflow.json"), "utf8"));

test("a valid workflow is written atomically and re-read identical", async () => {
  expect(await enreg(wf())).toEqual({ ok: true, ecrit: true, memoireEffacee: [] });
  expect(await lireJson()).toEqual(wf());
  expect((await readFile(join(fichiers, "workflow.json"), "utf8")).endsWith("}\n")).toBe(true);
  expect((await readdir(fichiers)).sort()).toEqual(["a.mjs", "workflow.json"]); // no .tmp
  const lu = await lireBrouillon(fichiers);
  expect(lu).toMatchObject({ origine: "fichier", brut: wf(), validation: { ok: true } });
});

test("an invalid workflow writes nothing and returns the error with the block concerned", async () => {
  const sansLien = { ...wf(), liens: [{ de: "a", vers: "s" }] }; // n without an input
  const r = await enreg(sansLien);
  expect(r).toMatchObject({ ok: false, bloc: "n" });
  expect(await readdir(fichiers)).toEqual(["a.mjs"]);
});

test("a code block whose .mjs file is missing is refused (R3), with the block", async () => {
  const brut = wf();
  brut.blocs[0]!.parametres = { source: "absent.mjs" };
  expect(await enreg(brut)).toEqual({ ok: false, erreur: "Non enregistré : fichier absent.mjs absent", bloc: "a" });
  expect(await readdir(fichiers)).toEqual(["a.mjs"]);
});

test("saving the same workflow writes nothing (ecrit false, mtime unchanged)", async () => {
  await enreg(wf());
  const passe = new Date("2020-01-01T00:00:00Z");
  await utimes(join(fichiers, "workflow.json"), passe, passe);
  // Same workflow, keys in another order.
  const memeAutrement = { liens: wf().liens, blocs: wf().blocs.map((b) => ({ parametres: b.parametres, position: b.position, type: b.type, id: b.id })), version: 1 };
  expect(await enreg(memeAutrement)).toEqual({ ok: true, ecrit: false, memoireEffacee: [] });
  expect((await stat(join(fichiers, "workflow.json"))).mtime).toEqual(passe);
});

test("the implicit one saved as is writes nothing; modified, it creates workflow.json and recolte.mjs stays", async () => {
  await writeFile(join(fichiers, "recolte.mjs"), "export default () => []");
  const avant = await lireBrouillon(fichiers);
  expect(avant).toMatchObject({ origine: "implicite", brut: workflowImplicite(), validation: { ok: true } });
  expect((await readdir(fichiers)).sort()).toEqual(["a.mjs", "recolte.mjs"]); // lire writes nothing
  expect(await enreg(avant!.brut)).toEqual({ ok: true, ecrit: false, memoireEffacee: [] });
  expect((await readdir(fichiers)).sort()).toEqual(["a.mjs", "recolte.mjs"]);

  const deplace = workflowImplicite();
  deplace.blocs[0]!.position = { x: 40, y: 50 };
  expect(await enreg(deplace)).toMatchObject({ ok: true, ecrit: true });
  expect((await readdir(fichiers)).sort()).toEqual(["a.mjs", "recolte.mjs", "workflow.json"]);
});

test("changing a block's parameters erases its memory, not the others'; changing its name or position does not erase it", async () => {
  await enreg(wf());
  const m = {
    n: { type: "liste.nouveaux", valeur: ["x"], empreinte: empreinteParametres({ cle: "url" }) },
    a: { type: "code", valeur: 1 },
  };
  await ecrireMemoire(donnees, m);

  const renomme = wf();
  renomme.blocs[1] = { ...renomme.blocs[1]!, nom: "Autre nom", position: { x: 99, y: 99 } } as never;
  expect(await enreg(renomme)).toEqual({ ok: true, ecrit: true, memoireEffacee: [] });
  expect(await lireMemoire(donnees)).toEqual(m);

  expect(await enreg(wf("titre"))).toEqual({ ok: true, ecrit: true, memoireEffacee: ["n"] });
  expect(await lireMemoire(donnees)).toEqual({ a: m.a });
});

test("changing the parameters also erases a memory from before the hashes; an entry already at the new settings stays", async () => {
  await enreg(wf());
  await ecrireMemoire(donnees, { n: { type: "liste.nouveaux", valeur: ["x"] }, a: { type: "code", valeur: 1 } });
  expect(await enreg(wf("titre"))).toEqual({ ok: true, ecrit: true, memoireEffacee: ["n"] });
  expect(await lireMemoire(donnees)).toEqual({ a: { type: "code", valeur: 1 } });

  // A run that already ran with the new settings (between the write and the erase) keeps its memory.
  const neuve = { n: { type: "liste.nouveaux", valeur: ["y"], empreinte: empreinteParametres({ cle: "id" }) } };
  await ecrireMemoire(donnees, neuve);
  expect(await enreg(wf("id"))).toEqual({ ok: true, ecrit: true, memoireEffacee: [] });
  expect(await lireMemoire(donnees)).toEqual(neuve);
});

test("the erase waits for the memory lock (held by the runs) and goes before the workflow write", async () => {
  await enreg(wf());
  await ecrireMemoire(donnees, { n: { type: "liste.nouveaux", valeur: ["x"], empreinte: empreinteParametres({ cle: "url" }) } });
  let liberer!: () => void;
  const relache = new Promise<void>((r) => (liberer = r));
  // A run started with the old settings writes its memory during the save.
  const execution = avecMemoire(donnees, async () => {
    await relache;
    await ecrireMemoire(donnees, {
      a: { type: "code", valeur: "fraiche" },
      n: { type: "liste.nouveaux", valeur: ["x", "z"], empreinte: empreinteParametres({ cle: "url" }) },
    });
  });
  const enregistrement = enreg(wf("titre"));
  await new Promise((r) => setTimeout(r, 30));
  // Nothing is written while the run holds the memory: neither the erase, nor the workflow.
  expect(JSON.parse(await readFile(join(fichiers, "workflow.json"), "utf8")).blocs[1].parametres).toEqual({ cle: "url" });
  liberer();
  await execution;
  expect(await enregistrement).toEqual({ ok: true, ecrit: true, memoireEffacee: ["n"] });
  // The run's fresh memory stays; the changed block's goes away.
  expect(await lireMemoire(donnees)).toEqual({ a: { type: "code", valeur: "fraiche" } });
});

test("nothing to erase: memoire.json is not rewritten", async () => {
  await enreg(wf());
  await ecrireMemoire(donnees, { a: { type: "code", valeur: 1 } });
  const passe = new Date("2020-01-01T00:00:00Z");
  await utimes(join(donnees, "memoire.json"), passe, passe);
  expect(await enreg(wf("titre"))).toEqual({ ok: true, ecrit: true, memoireEffacee: [] });
  expect((await stat(join(donnees, "memoire.json"))).mtime).toEqual(passe);
});

test("changing the implicit one's parameters also erases the memory (compared to the implicit one)", async () => {
  await writeFile(join(fichiers, "recolte.mjs"), "export default () => []");
  await ecrireMemoire(donnees, { recolte: { type: "code", valeur: 1 } });
  const change = workflowImplicite();
  change.blocs[0]!.parametres = { source: "a.mjs", appel: "entree" };
  expect(await enreg(change)).toEqual({ ok: true, ecrit: true, memoireEffacee: ["recolte"] });
});

test("workflow.json symbolic link to the outside: refused, the target is not touched", async () => {
  const dehors = join(racine, "dehors.json");
  await writeFile(dehors, "intact");
  await symlink(dehors, join(fichiers, "workflow.json"));
  expect(await enreg(wf())).toMatchObject({ ok: false });
  expect(await readFile(dehors, "utf8")).toBe("intact");
  expect(await lireBrouillon(fichiers)).toMatchObject({ origine: "fichier", brut: null, validation: { ok: false } });
});

test("over 256 KB: refused; widget folder missing: Widget introuvable", async () => {
  const gros = wf();
  gros.blocs[1]!.parametres = { cle: "x".repeat(300 * 1024) };
  expect((await enreg(gros)).ok).toBe(false);
  expect(await readdir(fichiers)).toEqual(["a.mjs"]);
  const r = await enregistrerWorkflow({ dossierFichiers: join(racine, "nulle-part"), dossierDonnees: donnees, brut: wf() });
  expect(r).toEqual({ ok: false, erreur: "Widget introuvable" });
});

test("lireBrouillon returns the JSON even invalid, null for a cut JSON, the implicit one for recolte.mjs alone", async () => {
  expect(await lireBrouillon(fichiers)).toBeNull();
  const invalide = { ...wf(), liens: [] };
  await writeFile(join(fichiers, "workflow.json"), JSON.stringify(invalide));
  const l = await lireBrouillon(fichiers);
  expect(l).toMatchObject({ origine: "fichier", brut: invalide, validation: { ok: false, bloc: "n" } });
  await writeFile(join(fichiers, "workflow.json"), '{ "version": 1, "blo');
  expect(await lireBrouillon(fichiers)).toMatchObject({ origine: "fichier", brut: null, validation: { ok: false } });
  await writeFile(join(fichiers, "workflow.json"), " ".repeat(300 * 1024));
  expect(await lireBrouillon(fichiers)).toMatchObject({ brut: null, validation: { ok: false } });
});

test("lireCode / enregistrerCode refuse ../x.mjs, x.js, an outgoing link, over 256 KB; a missing file returns absent", async () => {
  for (const nom of ["../x.mjs", "x.js", "A.mjs", "sous/x.mjs"]) {
    expect(await lireCode(fichiers, nom)).toHaveProperty("erreur");
    expect(await enregistrerCode(fichiers, nom, "x")).toMatchObject({ ok: false });
  }
  expect(await lireCode(fichiers, "nouveau.mjs")).toEqual({ absent: true });
  expect(await lireCode(fichiers, "a.mjs")).toEqual({ texte: "export default () => []" });

  const dehors = join(racine, "dehors.mjs");
  await writeFile(dehors, "intact");
  await symlink(dehors, join(fichiers, "lien.mjs"));
  const l = await lireCode(fichiers, "lien.mjs");
  expect(l).toHaveProperty("erreur");
  expect(JSON.stringify(l)).not.toContain(racine);
  expect(await enregistrerCode(fichiers, "lien.mjs", "écrasé")).toMatchObject({ ok: false });
  expect(await readFile(dehors, "utf8")).toBe("intact");

  const gros = "x".repeat(CODE_MAX_OCTETS + 1);
  expect(await enregistrerCode(fichiers, "gros.mjs", gros)).toMatchObject({ ok: false });
  await writeFile(join(fichiers, "gros2.mjs"), gros);
  expect(await lireCode(fichiers, "gros2.mjs")).toHaveProperty("erreur");

  expect(await enregistrerCode(fichiers, "nouveau.mjs", "export default 1")).toEqual({ ok: true });
  expect(await lireCode(fichiers, "nouveau.mjs")).toEqual({ texte: "export default 1" });
  expect((await readdir(fichiers)).filter((n) => n.endsWith(".tmp"))).toEqual([]);
});

test("changing liste.nouveaux's garderJours does not erase its memory; changing cle erases it", async () => {
  const avecGarder = (cle: string, garderJours?: number) => {
    const w = wf(cle);
    if (garderJours !== undefined) w.blocs[1]!.parametres = { cle, garderJours } as never;
    return w;
  };
  await enreg(avecGarder("url", 7));
  const m = { n: { type: "liste.nouveaux", valeur: ["x"], empreinte: empreinteParametres({ cle: "url", garderJours: 7 }) } };
  await ecrireMemoire(donnees, m);
  expect(await enreg(avecGarder("url", 30))).toEqual({ ok: true, ecrit: true, memoireEffacee: [] });
  expect(await enreg(avecGarder("url"))).toEqual({ ok: true, ecrit: true, memoireEffacee: [] });
  expect(await lireMemoire(donnees)).toEqual(m);
  expect(await enreg(avecGarder("titre", 30))).toEqual({ ok: true, ecrit: true, memoireEffacee: ["n"] });
  expect(await lireMemoire(donnees)).toEqual({});
});

test("the workflow in place is re-read with the widget's context: a long widget erases the memory and does not rewrite an identical file", async () => {
  const contexte = { web: false, dureeMaxMinutes: 30, proprietaire: "widget" as const, saisie: false };
  const long = (cle: string) => {
    const w = wf(cle);
    w.blocs.splice(1, 0, { id: "p", type: "source.page", position: { x: 0, y: 0 }, parametres: { url: "https://x.fr/{url}", parElement: true, budgetSecondes: 600 } } as never);
    w.liens = [{ de: "a", vers: "p" }, { de: "p", vers: "n" }, { de: "n", vers: "s" }];
    return w;
  };
  const enregLong = (brut: unknown) => enregistrerWorkflow({ dossierFichiers: fichiers, dossierDonnees: donnees, brut, contexte });
  // Without the context, this workflow is refused (600 s > 170 s).
  expect(await enreg(long("url"))).toMatchObject({ ok: false, bloc: "p" });
  expect(await enregLong(long("url"))).toEqual({ ok: true, ecrit: true, memoireEffacee: [] });
  expect(await lireBrouillon(fichiers, contexte)).toMatchObject({ validation: { ok: true } });
  expect(await lireBrouillon(fichiers)).toMatchObject({ validation: { ok: false } });

  const passe = new Date("2020-01-01T00:00:00Z");
  await utimes(join(fichiers, "workflow.json"), passe, passe);
  expect(await enregLong(long("url"))).toEqual({ ok: true, ecrit: false, memoireEffacee: [] });
  expect((await stat(join(fichiers, "workflow.json"))).mtime).toEqual(passe);

  await ecrireMemoire(donnees, { n: { type: "liste.nouveaux", valeur: ["x"], empreinte: empreinteParametres({ cle: "url" }) } });
  expect(await enregLong(long("titre"))).toEqual({ ok: true, ecrit: true, memoireEffacee: ["n"] });
});

test("saving web.chercher in a widget without web: refused, nothing written", async () => {
  const brut = wf();
  brut.blocs.splice(1, 0, { id: "w", type: "web.chercher", position: { x: 0, y: 0 }, parametres: { requete: "{titre}", parElement: true } } as never);
  brut.liens = [{ de: "a", vers: "w" }, { de: "w", vers: "n" }, { de: "n", vers: "s" }];
  const attendu = { ok: false, erreur: 'Workflow invalide : web.chercher : le widget doit déclarer "web": true', bloc: "w" };
  expect(await enreg(brut)).toEqual(attendu);
  expect(await enregistrerWorkflow({ dossierFichiers: fichiers, dossierDonnees: donnees, brut, contexte: { web: false, dureeMaxMinutes: 30, proprietaire: "widget" as const, saisie: false } })).toEqual(attendu);
  expect(await readdir(fichiers)).toEqual(["a.mjs"]);
  // With web, the same workflow is written.
  expect(await enregistrerWorkflow({ dossierFichiers: fichiers, dossierDonnees: donnees, brut, contexte: { web: true, dureeMaxMinutes: null, proprietaire: "widget" as const, saisie: false } })).toMatchObject({ ok: true, ecrit: true });
});
