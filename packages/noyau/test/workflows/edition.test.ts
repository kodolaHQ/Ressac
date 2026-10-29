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

test("un workflow valide est écrit atomiquement et relu identique", async () => {
  expect(await enreg(wf())).toEqual({ ok: true, ecrit: true, memoireEffacee: [] });
  expect(await lireJson()).toEqual(wf());
  expect((await readFile(join(fichiers, "workflow.json"), "utf8")).endsWith("}\n")).toBe(true);
  expect((await readdir(fichiers)).sort()).toEqual(["a.mjs", "workflow.json"]); // pas de .tmp
  const lu = await lireBrouillon(fichiers);
  expect(lu).toMatchObject({ origine: "fichier", brut: wf(), validation: { ok: true } });
});

test("un workflow invalide n'écrit rien et rend l'erreur avec le bloc en cause", async () => {
  const sansLien = { ...wf(), liens: [{ de: "a", vers: "s" }] }; // n sans entrée
  const r = await enreg(sansLien);
  expect(r).toMatchObject({ ok: false, bloc: "n" });
  expect(await readdir(fichiers)).toEqual(["a.mjs"]);
});

test("un bloc code dont le fichier .mjs est absent est refusé (R3), avec le bloc", async () => {
  const brut = wf();
  brut.blocs[0]!.parametres = { source: "absent.mjs" };
  expect(await enreg(brut)).toEqual({ ok: false, erreur: "Non enregistré : fichier absent.mjs absent", bloc: "a" });
  expect(await readdir(fichiers)).toEqual(["a.mjs"]);
});

test("enregistrer le même workflow n'écrit rien (ecrit false, mtime inchangé)", async () => {
  await enreg(wf());
  const passe = new Date("2020-01-01T00:00:00Z");
  await utimes(join(fichiers, "workflow.json"), passe, passe);
  // Même workflow, clés dans un autre ordre.
  const memeAutrement = { liens: wf().liens, blocs: wf().blocs.map((b) => ({ parametres: b.parametres, position: b.position, type: b.type, id: b.id })), version: 1 };
  expect(await enreg(memeAutrement)).toEqual({ ok: true, ecrit: false, memoireEffacee: [] });
  expect((await stat(join(fichiers, "workflow.json"))).mtime).toEqual(passe);
});

test("l'implicite enregistré tel quel n'écrit rien ; modifié, il crée workflow.json et recolte.mjs reste", async () => {
  await writeFile(join(fichiers, "recolte.mjs"), "export default () => []");
  const avant = await lireBrouillon(fichiers);
  expect(avant).toMatchObject({ origine: "implicite", brut: workflowImplicite(), validation: { ok: true } });
  expect((await readdir(fichiers)).sort()).toEqual(["a.mjs", "recolte.mjs"]); // lire n'écrit rien
  expect(await enreg(avant!.brut)).toEqual({ ok: true, ecrit: false, memoireEffacee: [] });
  expect((await readdir(fichiers)).sort()).toEqual(["a.mjs", "recolte.mjs"]);

  const deplace = workflowImplicite();
  deplace.blocs[0]!.position = { x: 40, y: 50 };
  expect(await enreg(deplace)).toMatchObject({ ok: true, ecrit: true });
  expect((await readdir(fichiers)).sort()).toEqual(["a.mjs", "recolte.mjs", "workflow.json"]);
});

test("changer les paramètres d'un bloc efface sa mémoire, pas celle des autres ; changer son nom ou sa position ne l'efface pas", async () => {
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

test("changer les paramètres efface aussi une mémoire d'avant les empreintes ; une entrée déjà aux nouveaux réglages reste", async () => {
  await enreg(wf());
  await ecrireMemoire(donnees, { n: { type: "liste.nouveaux", valeur: ["x"] }, a: { type: "code", valeur: 1 } });
  expect(await enreg(wf("titre"))).toEqual({ ok: true, ecrit: true, memoireEffacee: ["n"] });
  expect(await lireMemoire(donnees)).toEqual({ a: { type: "code", valeur: 1 } });

  // Une exécution qui a déjà tourné avec les nouveaux réglages (entre l'écriture et l'effacement) garde sa mémoire.
  const neuve = { n: { type: "liste.nouveaux", valeur: ["y"], empreinte: empreinteParametres({ cle: "id" }) } };
  await ecrireMemoire(donnees, neuve);
  expect(await enreg(wf("id"))).toEqual({ ok: true, ecrit: true, memoireEffacee: [] });
  expect(await lireMemoire(donnees)).toEqual(neuve);
});

test("l'effacement attend le verrou de la mémoire (pris par les exécutions) et passe avant l'écriture du workflow", async () => {
  await enreg(wf());
  await ecrireMemoire(donnees, { n: { type: "liste.nouveaux", valeur: ["x"], empreinte: empreinteParametres({ cle: "url" }) } });
  let liberer!: () => void;
  const relache = new Promise<void>((r) => (liberer = r));
  // Une exécution partie avec les anciens réglages écrit sa mémoire pendant l'enregistrement.
  const execution = avecMemoire(donnees, async () => {
    await relache;
    await ecrireMemoire(donnees, {
      a: { type: "code", valeur: "fraiche" },
      n: { type: "liste.nouveaux", valeur: ["x", "z"], empreinte: empreinteParametres({ cle: "url" }) },
    });
  });
  const enregistrement = enreg(wf("titre"));
  await new Promise((r) => setTimeout(r, 30));
  // Rien n'est écrit tant que l'exécution tient la mémoire : ni l'effacement, ni le workflow.
  expect(JSON.parse(await readFile(join(fichiers, "workflow.json"), "utf8")).blocs[1].parametres).toEqual({ cle: "url" });
  liberer();
  await execution;
  expect(await enregistrement).toEqual({ ok: true, ecrit: true, memoireEffacee: ["n"] });
  // La mémoire fraîche de l'exécution reste ; celle du bloc changé part.
  expect(await lireMemoire(donnees)).toEqual({ a: { type: "code", valeur: "fraiche" } });
});

test("rien à effacer : memoire.json n'est pas réécrit", async () => {
  await enreg(wf());
  await ecrireMemoire(donnees, { a: { type: "code", valeur: 1 } });
  const passe = new Date("2020-01-01T00:00:00Z");
  await utimes(join(donnees, "memoire.json"), passe, passe);
  expect(await enreg(wf("titre"))).toEqual({ ok: true, ecrit: true, memoireEffacee: [] });
  expect((await stat(join(donnees, "memoire.json"))).mtime).toEqual(passe);
});

test("changer les paramètres de l'implicite efface aussi la mémoire (comparé à l'implicite)", async () => {
  await writeFile(join(fichiers, "recolte.mjs"), "export default () => []");
  await ecrireMemoire(donnees, { recolte: { type: "code", valeur: 1 } });
  const change = workflowImplicite();
  change.blocs[0]!.parametres = { source: "a.mjs", appel: "entree" };
  expect(await enreg(change)).toEqual({ ok: true, ecrit: true, memoireEffacee: ["recolte"] });
});

test("workflow.json lien symbolique vers l'extérieur : refusé, la cible n'est pas touchée", async () => {
  const dehors = join(racine, "dehors.json");
  await writeFile(dehors, "intact");
  await symlink(dehors, join(fichiers, "workflow.json"));
  expect(await enreg(wf())).toMatchObject({ ok: false });
  expect(await readFile(dehors, "utf8")).toBe("intact");
  expect(await lireBrouillon(fichiers)).toMatchObject({ origine: "fichier", brut: null, validation: { ok: false } });
});

test("plus de 256 Ko : refusé ; dossier du widget absent : Widget introuvable", async () => {
  const gros = wf();
  gros.blocs[1]!.parametres = { cle: "x".repeat(300 * 1024) };
  expect((await enreg(gros)).ok).toBe(false);
  expect(await readdir(fichiers)).toEqual(["a.mjs"]);
  const r = await enregistrerWorkflow({ dossierFichiers: join(racine, "nulle-part"), dossierDonnees: donnees, brut: wf() });
  expect(r).toEqual({ ok: false, erreur: "Widget introuvable" });
});

test("lireBrouillon rend le JSON même invalide, null pour un JSON coupé, l'implicite pour recolte.mjs seul", async () => {
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

test("lireCode / enregistrerCode refusent ../x.mjs, x.js, un lien sortant, plus de 256 Ko ; un fichier absent rend absent", async () => {
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
