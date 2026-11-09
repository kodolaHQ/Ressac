import { catalogueBlocs, validateWorkflow, implicitWorkflow } from "@webaios/noyau";
import { expect, test } from "vitest";
import type { Draft, EditionWorkflow } from "../../shared/api";
import { MODELE_CODE, parametresNeufs, placeLibre } from "../../ui/constructeur/ajout";
import { regler, relier } from "../../ui/constructeur/brouillon";
import { creerEdition, Edition, EN_ATTENTE_DU_CHOIX, oublierEditions, type Depot } from "../../ui/constructeur/edition.svelte";

const bloc = (id: string, type: string, parametres: Record<string, unknown> = {}) => ({ id, type, position: { x: 0, y: 0 }, parametres });
/** Workflow shipped without positions. */
const livre = (): Draft => ({
  version: 1,
  blocs: [bloc("garder", "code", { source: "a.mjs" }), bloc("tri", "ia.trier", { question: "?", texte: "{t}" }), bloc("sortie", "sortie", { vers: "widget" })],
  liens: [
    { de: "garder", vers: "tri" },
    { de: "tri", vers: "sortie" },
  ],
});
const catalogue = (type: string) => catalogueBlocs().find((c) => c.type === type)!;
const attendre = () => new Promise((r) => setTimeout(r, 0));

/** Fake repository: an in-memory `workflow.json`, checked by the real validator; keeps a trace of the writes. */
function faux(initial: unknown, fichiers: Record<string, string> = {}) {
  const etat = {
    disque: structuredClone(initial) as unknown,
    lisible: true,
    introuvable: false,
    fichiers: { ...fichiers },
    /** Code read error; refusal to write the code; saves suspended until `liberer()`. */
    erreurCode: false as boolean | string[],
    refusCode: false,
    suspendu: false,
  };
  const enAttente: (() => void)[] = [];
  const ecritures: Draft[] = [];
  const lecture = (): EditionWorkflow | null => {
    if (etat.introuvable) return null;
    const brut = etat.lisible ? structuredClone(etat.disque) : null;
    const v = brut === null ? { ok: false as const, erreur: "Workflow invalide : JSON coupé" } : validateWorkflow(structuredClone(brut));
    return {
      origine: "fichier",
      brut,
      validation: v.ok ? { ok: true } : { ok: false, erreur: v.erreur, ...(v.bloc ? { bloc: v.bloc } : {}) },
      avertissements: [],
      widget: { nom: "Essai", compte: [], publiques: [], config: {}, web: false, recolte: null },
    };
  };
  const depot: Depot = {
    lire: async () => lecture(),
    enregistrer: async (_id, b) => {
      if (etat.suspendu) await new Promise<void>((ok) => enAttente.push(ok));
      const v = validateWorkflow(structuredClone(b));
      if (!v.ok) return { ok: false, erreur: v.erreur, ...(v.bloc ? { bloc: v.bloc } : {}), avertissements: [] };
      ecritures.push(structuredClone(b));
      etat.disque = structuredClone(b);
      return { ok: true, ecrit: true, memoireEffacee: [], avertissements: [] };
    },
    lireCode: async (_id, nom) => (etat.erreurCode === true || (Array.isArray(etat.erreurCode) && etat.erreurCode.includes(nom)) ? { erreur: "Fichier illisible" } : nom in etat.fichiers ? { texte: etat.fichiers[nom]! } : { absent: true }),
    enregistrerCode: async (_id, nom, texte) => {
      if (etat.refusCode) return { ok: false, erreur: "Écriture impossible" };
      etat.fichiers[nom] = texte;
      return { ok: true };
    },
  };
  const liberer = () => {
    etat.suspendu = false;
    for (const ok of enAttente.splice(0)) ok();
  };
  return { depot, etat, ecritures, liberer };
}

async function ouverte(f: ReturnType<typeof faux>): Promise<Edition> {
  const e = new Edition("essai", f.depot);
  await e.ouvrir();
  return e;
}

test("opening a workflow shipped without positions lays it out in columns and writes nothing", async () => {
  const f = faux(livre());
  const e = await ouverte(f);
  expect(e.chargement).toBe("pret");
  expect(e.etatEnregistrement).toBe("enregistre");
  expect(e.positions).toEqual({ garder: { x: 0, y: 0 }, tri: { x: 260, y: 0 }, sortie: { x: 520, y: 0 } });
  e.reorganiser();
  await e.relire();
  await attendre();
  expect(f.ecritures).toEqual([]);
});

test("the first move saves the displayed position of all blocks; a zero move writes nothing", async () => {
  const f = faux(livre());
  const e = await ouverte(f);
  e.deplacer({ ...e.positions });
  await attendre();
  expect(f.ecritures).toEqual([]);
  e.deplacer({ ...e.positions, tri: { x: 300, y: 40 } });
  await attendre();
  expect(f.ecritures).toHaveLength(1);
  expect(Object.fromEntries(f.ecritures[0]!.blocs.map((b) => [b.id, b.position]))).toEqual({
    garder: { x: 0, y: 0 },
    tri: { x: 300, y: 40 },
    sortie: { x: 520, y: 0 },
  });
  expect(e.positions.sortie).toEqual({ x: 520, y: 0 });
});

test("a new unlinked block is « non enregistré : entrée manquante »; linked, it saves; ⌘Z goes back and saves again", async () => {
  const f = faux(livre());
  const e = await ouverte(f);
  const id = await e.ajouter(catalogue("liste.dedoublonner"), { x: 0, y: 300 });
  await attendre();
  expect(id).toBe("liste-dedoublonner");
  expect(e.etatEnregistrement).toMatchObject({ invalide: expect.stringContaining("entrée manquante"), bloc: id });
  expect(e.validation).toMatchObject({ ok: false, bloc: id });
  expect(f.ecritures).toEqual([]);
  e.modifier((b) => relier(b, "garder", id));
  await attendre();
  expect(e.etatEnregistrement).toBe("enregistre");
  expect(f.ecritures.at(-1)!.blocs.find((b) => b.id === id)!.parametres).toEqual({ cles: ["url"] });
  e.annuler();
  await attendre();
  expect(e.etatEnregistrement).toMatchObject({ invalide: expect.stringContaining("entrée manquante") });
  expect(f.ecritures).toHaveLength(1);
  e.annuler();
  await attendre();
  expect(e.etatEnregistrement).toBe("enregistre");
  expect(f.ecritures.at(-1)!.blocs.map((b) => b.id)).toEqual(["garder", "tri", "sortie"]);
  // Displayed positions do not jump when going back to the workflow without layout.
  expect(e.positions.tri).toEqual({ x: 260, y: 0 });
  e.retablir();
  expect(e.brouillon!.blocs.map((b) => b.id)).toContain(id);
});

test("a new code block gets its template file (never an existing file) before being saved", async () => {
  const f = faux(livre(), { "code.mjs": "// de l'agent" });
  const e = await ouverte(f);
  const id = await e.ajouter(catalogue("code"), { x: 0, y: 300 });
  await attendre();
  expect(id).toBe("code");
  expect(f.etat.fichiers["code.mjs"]).toBe("// de l'agent");
  expect(f.etat.fichiers["code-2.mjs"]).toBe(MODELE_CODE);
  expect(f.ecritures.at(-1)!.blocs.find((b) => b.id === "code")!.parametres).toEqual({ source: "code-2.mjs" });
  expect(e.etatEnregistrement).toBe("enregistre");
});

test("relire: the echo of a save is ignored; an agent version is adopted without writing anything", async () => {
  const f = faux(livre());
  const e = await ouverte(f);
  e.deplacer({ ...e.positions, tri: { x: 300, y: 40 } });
  await e.relire();
  await attendre();
  expect(e.bandeau).toBeNull();
  const agent = structuredClone(f.etat.disque) as Draft;
  agent.blocs[0]!.parametres = { source: "b.mjs" };
  f.etat.disque = agent;
  await e.relire();
  expect(e.bandeau).toBeNull();
  expect(e.brouillon!.blocs[0]!.parametres).toEqual({ source: "b.mjs" });
  expect(f.ecritures).toHaveLength(1);
});

test("relire with an invalid draft offers the agent's version; take or keep", async () => {
  const f = faux(livre());
  const e = await ouverte(f);
  await e.ajouter(catalogue("liste.garder"), { x: 0, y: 300 });
  await attendre();
  const agent = livre();
  agent.blocs[0]!.parametres = { source: "b.mjs" };
  f.etat.disque = agent;
  await e.relire();
  expect(e.bandeau).toBe("proposer");
  expect(e.brouillon!.blocs.map((b) => b.id)).toContain("liste-garder");
  e.garderLaMienne();
  expect(e.bandeau).toBeNull();
  await e.relire();
  expect(e.bandeau).toBeNull();
  agent.blocs[0]!.parametres = { source: "c.mjs" };
  f.etat.disque = structuredClone(agent);
  await e.relire();
  expect(e.bandeau).toBe("proposer");
  e.prendreVersionDisque();
  expect(e.bandeau).toBeNull();
  expect(e.brouillon!.blocs.map((b) => b.id)).toEqual(["garder", "tri", "sortie"]);
  expect(e.etatEnregistrement).toBe("enregistre");
  await attendre();
  expect(f.ecritures).toEqual([]);
});

test("relire: cut-off JSON → « illisible » banner without touching the canvas; widget not found for a moment → canvas kept", async () => {
  const f = faux(livre());
  const e = await ouverte(f);
  const avant = e.brouillon;
  f.etat.lisible = false;
  await e.relire();
  expect(e.bandeau).toBe("illisible");
  expect(e.brouillon).toBe(avant);
  f.etat.lisible = true;
  f.etat.introuvable = true;
  await e.relire();
  expect(e.brouillon).toBe(avant);
  expect(e.chargement).toBe("pret");
  f.etat.introuvable = false;
  await e.relire();
  expect(e.bandeau).toBeNull();
});

test("on first open: not found, or unreadable with the error", async () => {
  const absent = faux(livre());
  absent.etat.introuvable = true;
  expect((await ouverte(absent)).chargement).toBe("introuvable");
  const coupe = faux(livre());
  coupe.etat.lisible = false;
  expect((await ouverte(coupe)).chargement).toEqual({ illisible: "Workflow invalide : JSON coupé" });
});

test("the implicit workflow (Gmail) opens laid out, without a write", async () => {
  const f = faux(implicitWorkflow());
  const e = await ouverte(f);
  expect(e.positions).toEqual({ recolte: { x: 0, y: 0 }, sortie: { x: 260, y: 0 } });
  e.deplacer({ ...e.positions });
  e.modifier((b) => relier(b, "sortie", "recolte"));
  await attendre();
  expect(f.ecritures).toEqual([]);
});

test("one edition per widget in the window", () => {
  const { depot } = faux(livre());
  expect(creerEdition("w1", depot)).toBe(creerEdition("w1", depot));
  expect(creerEdition("w1", depot)).not.toBe(creerEdition("w2", depot));
});

test("new parameters: neutral values for required fields, no invented address", () => {
  expect(parametresNeufs(catalogue("liste.garder"))).toEqual({ nombre: 10 });
  expect(parametresNeufs(catalogue("liste.nouveaux"))).toEqual({ cle: "url" });
  expect(parametresNeufs(catalogue("ia.trier"))).toEqual({ question: "Est-ce intéressant ?", texte: "{titre}" });
  expect(parametresNeufs(catalogue("source.page"))).toEqual({});
});

test("placeLibre shifts below the displayed blocks", () => {
  expect(placeLibre({ x: 10, y: 0 }, [])).toEqual({ x: 10, y: 0 });
  expect(placeLibre({ x: 10, y: 0 }, [{ x: 0, y: 0 }, { x: 0, y: 110 }])).toEqual({ x: 10, y: 220 });
});

// Fix round 1 (review of task 9)

/** Invalid draft (unlinked block), then the agent changes `garder` on disk: the banner offers its version. */
async function avecBandeau() {
  const f = faux(livre());
  const e = await ouverte(f);
  const id = await e.ajouter(catalogue("liste.garder"), { x: 0, y: 300 });
  await attendre();
  const agent = livre();
  agent.blocs[0]!.parametres = { source: "b.mjs" };
  f.etat.disque = agent;
  await e.relire();
  expect(e.bandeau).toBe("proposer");
  return { f, e, id };
}

test("I1: a gesture during the banner writes nothing and the banner stays; « Garder la mienne » sends the draft", async () => {
  const { f, e, id } = await avecBandeau();
  e.modifier((b) => relier(b, "garder", id));
  await attendre();
  expect(f.ecritures).toEqual([]);
  expect(e.bandeau).toBe("proposer");
  expect(e.etatEnregistrement).toEqual({ invalide: EN_ATTENTE_DU_CHOIX });
  expect((f.etat.disque as Draft).blocs[0]!.parametres).toEqual({ source: "b.mjs" });
  e.garderLaMienne();
  await attendre();
  expect(e.bandeau).toBeNull();
  expect(f.ecritures).toHaveLength(1);
  expect(f.ecritures[0]!.liens).toContainEqual({ de: "garder", vers: id });
  expect(f.ecritures[0]!.blocs[0]!.parametres).toEqual({ source: "a.mjs" });
  expect(e.etatEnregistrement).toBe("enregistre");
});

test("I1: a gesture during the banner, then « Prendre sa version »: the kept draft is dropped", async () => {
  const { f, e, id } = await avecBandeau();
  e.modifier((b) => relier(b, "garder", id));
  e.prendreVersionDisque();
  await attendre();
  expect(f.ecritures).toEqual([]);
  expect(e.bandeau).toBeNull();
  expect(e.brouillon!.blocs[0]!.parametres).toEqual({ source: "b.mjs" });
  expect(e.brouillon!.blocs.map((b) => b.id)).not.toContain(id);
  expect(e.etatEnregistrement).toBe("enregistre");
});

test("I2: ⌘Z after the first move of a workflow without layout puts the block back", async () => {
  const f = faux(livre());
  const e = await ouverte(f);
  e.deplacer({ ...e.positions, tri: { x: 300, y: 40 } });
  await attendre();
  e.annuler();
  await attendre();
  expect(e.positions.tri).toEqual({ x: 260, y: 0 });
  expect((f.etat.disque as Draft).blocs.find((b) => b.id === "tri")!.position).toEqual({ x: 0, y: 0 });
  e.retablir();
  expect(e.positions.tri).toEqual({ x: 300, y: 40 });
});

test("M2: relire during an in-flight save ignores the echo of the draft sent", async () => {
  const f = faux(livre());
  const e = await ouverte(f);
  f.etat.suspendu = true;
  e.deplacer({ ...e.positions, tri: { x: 300, y: 40 } });
  await attendre();
  // A second gesture waits its turn while the first is in flight.
  e.deplacer({ ...e.positions, tri: { x: 320, y: 60 } });
  // The disk already holds the first draft (written, response not yet received).
  const enVol = structuredClone(e.brouillon!);
  enVol.blocs.find((b) => b.id === "tri")!.position = { x: 300, y: 40 };
  f.etat.disque = enVol;
  await e.relire();
  expect(e.bandeau).toBeNull();
  expect(e.positions.tri).toEqual({ x: 320, y: 60 });
  f.liberer();
  await attendre();
  await attendre();
  expect(e.etatEnregistrement).toBe("enregistre");
});

test("M3: the edition of a widget that left the home is forgotten; a reused id starts from scratch", () => {
  const { depot } = faux(livre());
  const a = creerEdition("parti", depot);
  const b = creerEdition("reste", depot);
  oublierEditions(["reste"]);
  expect(creerEdition("parti", depot)).not.toBe(a);
  expect(creerEdition("reste", depot)).toBe(b);
});

test("M4: with no free file name (read error) or no template write, the Code block is not added", async () => {
  const f = faux(livre());
  const e = await ouverte(f);
  f.etat.erreurCode = true;
  expect(await e.ajouter(catalogue("code"), { x: 0, y: 300 })).toBe("");
  expect(e.brouillon!.blocs.map((b) => b.id)).toEqual(["garder", "tri", "sortie"]);
  expect(e.etatEnregistrement).toEqual({ erreur: "aucun nom de fichier libre pour le bloc Code" });
  f.etat.erreurCode = false;
  f.etat.refusCode = true;
  expect(await e.ajouter(catalogue("code"), { x: 0, y: 300 })).toBe("");
  expect(e.brouillon!.blocs.map((b) => b.id)).toEqual(["garder", "tri", "sortie"]);
  expect(e.etatEnregistrement).toEqual({ erreur: "Écriture impossible" });
  await attendre();
  expect(f.ecritures).toEqual([]);
  expect(Object.keys(f.etat.fichiers)).toEqual([]);
});

// Fix round 2

test("N1: a draft queued behind an in-flight save is kept if the banner appears in the meantime", async () => {
  const f = faux(livre());
  const e = await ouverte(f);
  f.etat.suspendu = true;
  e.deplacer({ ...e.positions, tri: { x: 300, y: 40 } });
  await attendre();
  e.deplacer({ ...e.positions, tri: { x: 320, y: 60 } });
  const agent = livre();
  agent.blocs[0]!.parametres = { source: "b.mjs" };
  f.etat.disque = agent;
  await e.relire();
  expect(e.bandeau).toBe("proposer");
  f.liberer();
  await attendre();
  await attendre();
  // Only the draft already in flight left; the queued one waits for the choice.
  expect(f.ecritures).toHaveLength(1);
  expect(f.ecritures[0]!.blocs.find((b) => b.id === "tri")!.position).toEqual({ x: 300, y: 40 });
  expect(e.bandeau).toBe("proposer");
  expect(e.etatEnregistrement).toEqual({ invalide: EN_ATTENTE_DU_CHOIX });
  // Taking its version also drops the queued draft.
  e.prendreVersionDisque();
  await attendre();
  expect(f.ecritures).toHaveLength(1);
  expect(e.brouillon!.blocs[0]!.parametres).toEqual({ source: "b.mjs" });
});

test("N2: a save that succeeds during the banner leaves the header waiting for the choice", async () => {
  const f = faux(livre());
  const e = await ouverte(f);
  f.etat.suspendu = true;
  e.deplacer({ ...e.positions, tri: { x: 300, y: 40 } });
  await attendre();
  const agent = livre();
  agent.blocs[0]!.parametres = { source: "b.mjs" };
  f.etat.disque = agent;
  await e.relire();
  expect(e.bandeau).toBe("proposer");
  f.liberer();
  await attendre();
  await attendre();
  expect(e.bandeau).toBe("proposer");
  expect(e.etatEnregistrement).toEqual({ invalide: EN_ATTENTE_DU_CHOIX });
});

test("N1: a read error on the first name stops the search (never a random next name)", async () => {
  const f = faux(livre());
  const e = await ouverte(f);
  f.etat.erreurCode = ["code.mjs"];
  expect(await e.ajouter(catalogue("code"), { x: 0, y: 300 })).toBe("");
  expect(e.brouillon!.blocs.map((b) => b.id)).toEqual(["garder", "tri", "sortie"]);
  expect(Object.keys(f.etat.fichiers)).toEqual([]);
});

test("N2: « Prendre sa version » before the end of an in-flight save also drops the queued draft", async () => {
  const f = faux(livre());
  const e = await ouverte(f);
  f.etat.suspendu = true;
  e.deplacer({ ...e.positions, tri: { x: 300, y: 40 } });
  await attendre();
  e.deplacer({ ...e.positions, tri: { x: 320, y: 60 } });
  const agent = livre();
  agent.blocs[0]!.parametres = { source: "b.mjs" };
  f.etat.disque = agent;
  await e.relire();
  e.prendreVersionDisque();
  f.liberer();
  await attendre();
  await attendre();
  expect(f.ecritures).toHaveLength(1);
  expect(f.ecritures[0]!.blocs.find((b) => b.id === "tri")!.position).toEqual({ x: 300, y: 40 });
});

test("T10: keystrokes in the same field (same merge key) make a single history entry", async () => {
  const f = faux(livre());
  const e = await ouverte(f);
  const seuil = (s: number) => (b: Draft) => regler(b, "tri", { ...b.blocs.find((x) => x.id === "tri")!.parametres, seuil: s });
  e.modifier(seuil(0.6), "tri/seuil/1");
  await attendre();
  e.modifier(seuil(0.7), "tri/seuil/1");
  await attendre();
  expect(f.ecritures.at(-1)!.blocs.find((b) => b.id === "tri")!.parametres.seuil).toBe(0.7);
  // Another session on the same field is another entry.
  e.modifier(seuil(0.8), "tri/seuil/2");
  await attendre();
  e.annuler();
  expect(e.brouillon!.blocs.find((b) => b.id === "tri")!.parametres.seuil).toBe(0.7);
  e.annuler();
  expect(e.brouillon!.blocs.find((b) => b.id === "tri")!.parametres.seuil).toBeUndefined();
  // After an undo, the same key no longer merges with the previous state.
  e.modifier(seuil(0.9), "tri/seuil/2");
  e.annuler();
  expect(e.brouillon!.blocs.find((b) => b.id === "tri")!.parametres.seuil).toBeUndefined();
});

test("source of a code block to a missing file: refused; once the code is saved, the draft restarts", async () => {
  const f = faux(livre(), { "a.mjs": "x" });
  const enregistrer = f.depot.enregistrer;
  // Like the kernel: a code block whose file is missing is refused, block named.
  f.depot.enregistrer = async (id, b) => {
    const manque = b.blocs.find((x) => x.type === "code" && !(String(x.parametres.source) in f.etat.fichiers));
    if (manque) return { ok: false, erreur: `Non enregistré : fichier ${String(manque.parametres.source)} absent`, bloc: manque.id, avertissements: [] };
    return enregistrer(id, b);
  };
  const e = await ouverte(f);
  e.modifier((b) => regler(b, "garder", { source: "b.mjs" }));
  await attendre();
  expect(e.etatEnregistrement).toEqual({ invalide: "fichier b.mjs absent", bloc: "garder" });
  expect(f.ecritures).toEqual([]);

  // Another saved file triggers nothing.
  f.etat.fichiers["c.mjs"] = "y";
  e.codeEnregistre("c.mjs");
  await attendre();
  expect(f.ecritures).toEqual([]);

  f.etat.fichiers["b.mjs"] = MODELE_CODE;
  e.codeEnregistre("b.mjs");
  expect(e.etatEnregistrement).toBe("en-cours");
  await attendre();
  expect(e.etatEnregistrement).toBe("enregistre");
  expect(f.ecritures.map((b) => b.blocs[0]!.parametres.source)).toEqual(["b.mjs"]);

  // Already saved: a new save of the code sends nothing.
  e.codeEnregistre("b.mjs");
  await attendre();
  expect(f.ecritures).toHaveLength(1);
});
