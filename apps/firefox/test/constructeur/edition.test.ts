import { catalogueBlocs, validateWorkflow, implicitWorkflow } from "@webaios/noyau";
import { expect, test } from "vitest";
import type { Draft, EditionWorkflow } from "../../shared/api";
import { CODE_MODEL, freshParams, freeSlot } from "../../ui/constructeur/ajout";
import { set, relier } from "../../ui/constructeur/brouillon";
import { createEdit, Edition, AWAITING_CHOICE, forgetEdits, type Depot } from "../../ui/constructeur/edition.svelte";

const bloc = (id: string, type: string, params: Record<string, unknown> = {}) => ({ id, type, position: { x: 0, y: 0 }, parametres: params });
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
const wait = () => new Promise((r) => setTimeout(r, 0));

/** Fake repository: an in-memory `workflow.json`, checked by the real validator; keeps a trace of the writes. */
function fake(initial: unknown, files: Record<string, string> = {}) {
  const state = {
    disque: structuredClone(initial) as unknown,
    lisible: true,
    introuvable: false,
    fichiers: { ...files },
    /** Code read error; refusal to write the code; saves suspended until `liberer()`. */
    erreurCode: false as boolean | string[],
    refusCode: false,
    suspendu: false,
  };
  const pending: (() => void)[] = [];
  const writes: Draft[] = [];
  const lecture = (): EditionWorkflow | null => {
    if (state.introuvable) return null;
    const brut = state.lisible ? structuredClone(state.disque) : null;
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
      if (state.suspendu) await new Promise<void>((ok) => pending.push(ok));
      const v = validateWorkflow(structuredClone(b));
      if (!v.ok) return { ok: false, erreur: v.erreur, ...(v.bloc ? { bloc: v.bloc } : {}), avertissements: [] };
      writes.push(structuredClone(b));
      state.disque = structuredClone(b);
      return { ok: true, ecrit: true, memoireEffacee: [], avertissements: [] };
    },
    lireCode: async (_id, name) => (state.erreurCode === true || (Array.isArray(state.erreurCode) && state.erreurCode.includes(name)) ? { erreur: "Fichier illisible" } : name in state.fichiers ? { texte: state.fichiers[name]! } : { absent: true }),
    enregistrerCode: async (_id, name, text) => {
      if (state.refusCode) return { ok: false, erreur: "Écriture impossible" };
      state.fichiers[name] = text;
      return { ok: true };
    },
  };
  const release = () => {
    state.suspendu = false;
    for (const ok of pending.splice(0)) ok();
  };
  return { depot, etat: state, ecritures: writes, liberer: release };
}

async function opened(f: ReturnType<typeof fake>): Promise<Edition> {
  const e = new Edition("essai", f.depot);
  await e.ouvrir();
  return e;
}

test("opening a workflow shipped without positions lays it out in columns and writes nothing", async () => {
  const f = fake(livre());
  const e = await opened(f);
  expect(e.chargement).toBe("pret");
  expect(e.etatEnregistrement).toBe("enregistre");
  expect(e.positions).toEqual({ garder: { x: 0, y: 0 }, tri: { x: 260, y: 0 }, sortie: { x: 520, y: 0 } });
  e.reorganiser();
  await e.relire();
  await wait();
  expect(f.ecritures).toEqual([]);
});

test("the first move saves the displayed position of all blocks; a zero move writes nothing", async () => {
  const f = fake(livre());
  const e = await opened(f);
  e.deplacer({ ...e.positions });
  await wait();
  expect(f.ecritures).toEqual([]);
  e.deplacer({ ...e.positions, tri: { x: 300, y: 40 } });
  await wait();
  expect(f.ecritures).toHaveLength(1);
  expect(Object.fromEntries(f.ecritures[0]!.blocs.map((b) => [b.id, b.position]))).toEqual({
    garder: { x: 0, y: 0 },
    tri: { x: 300, y: 40 },
    sortie: { x: 520, y: 0 },
  });
  expect(e.positions.sortie).toEqual({ x: 520, y: 0 });
});

test("a new unlinked block is « non enregistré : entrée manquante »; linked, it saves; ⌘Z goes back and saves again", async () => {
  const f = fake(livre());
  const e = await opened(f);
  const id = await e.ajouter(catalogue("liste.dedoublonner"), { x: 0, y: 300 });
  await wait();
  expect(id).toBe("liste-dedoublonner");
  expect(e.etatEnregistrement).toMatchObject({ invalide: expect.stringContaining("entrée manquante"), bloc: id });
  expect(e.validation).toMatchObject({ ok: false, bloc: id });
  expect(f.ecritures).toEqual([]);
  e.modifier((b) => relier(b, "garder", id));
  await wait();
  expect(e.etatEnregistrement).toBe("enregistre");
  expect(f.ecritures.at(-1)!.blocs.find((b) => b.id === id)!.parametres).toEqual({ cles: ["url"] });
  e.annuler();
  await wait();
  expect(e.etatEnregistrement).toMatchObject({ invalide: expect.stringContaining("entrée manquante") });
  expect(f.ecritures).toHaveLength(1);
  e.annuler();
  await wait();
  expect(e.etatEnregistrement).toBe("enregistre");
  expect(f.ecritures.at(-1)!.blocs.map((b) => b.id)).toEqual(["garder", "tri", "sortie"]);
  // Displayed positions do not jump when going back to the workflow without layout.
  expect(e.positions.tri).toEqual({ x: 260, y: 0 });
  e.retablir();
  expect(e.brouillon!.blocs.map((b) => b.id)).toContain(id);
});

test("a new code block gets its template file (never an existing file) before being saved", async () => {
  const f = fake(livre(), { "code.mjs": "// de l'agent" });
  const e = await opened(f);
  const id = await e.ajouter(catalogue("code"), { x: 0, y: 300 });
  await wait();
  expect(id).toBe("code");
  expect(f.etat.fichiers["code.mjs"]).toBe("// de l'agent");
  expect(f.etat.fichiers["code-2.mjs"]).toBe(CODE_MODEL);
  expect(f.ecritures.at(-1)!.blocs.find((b) => b.id === "code")!.parametres).toEqual({ source: "code-2.mjs" });
  expect(e.etatEnregistrement).toBe("enregistre");
});

test("relire: the echo of a save is ignored; an agent version is adopted without writing anything", async () => {
  const f = fake(livre());
  const e = await opened(f);
  e.deplacer({ ...e.positions, tri: { x: 300, y: 40 } });
  await e.relire();
  await wait();
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
  const f = fake(livre());
  const e = await opened(f);
  await e.ajouter(catalogue("liste.garder"), { x: 0, y: 300 });
  await wait();
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
  await wait();
  expect(f.ecritures).toEqual([]);
});

test("relire: cut-off JSON → « illisible » banner without touching the canvas; widget not found for a moment → canvas kept", async () => {
  const f = fake(livre());
  const e = await opened(f);
  const before = e.brouillon;
  f.etat.lisible = false;
  await e.relire();
  expect(e.bandeau).toBe("illisible");
  expect(e.brouillon).toBe(before);
  f.etat.lisible = true;
  f.etat.introuvable = true;
  await e.relire();
  expect(e.brouillon).toBe(before);
  expect(e.chargement).toBe("pret");
  f.etat.introuvable = false;
  await e.relire();
  expect(e.bandeau).toBeNull();
});

test("on first open: not found, or unreadable with the error", async () => {
  const absent = fake(livre());
  absent.etat.introuvable = true;
  expect((await opened(absent)).chargement).toBe("introuvable");
  const coupe = fake(livre());
  coupe.etat.lisible = false;
  expect((await opened(coupe)).chargement).toEqual({ illisible: "Workflow invalide : JSON coupé" });
});

test("the implicit workflow (Gmail) opens laid out, without a write", async () => {
  const f = fake(implicitWorkflow());
  const e = await opened(f);
  expect(e.positions).toEqual({ recolte: { x: 0, y: 0 }, sortie: { x: 260, y: 0 } });
  e.deplacer({ ...e.positions });
  e.modifier((b) => relier(b, "sortie", "recolte"));
  await wait();
  expect(f.ecritures).toEqual([]);
});

test("one edition per widget in the window", () => {
  const { depot } = fake(livre());
  expect(createEdit("w1", depot)).toBe(createEdit("w1", depot));
  expect(createEdit("w1", depot)).not.toBe(createEdit("w2", depot));
});

test("new parameters: neutral values for required fields, no invented address", () => {
  expect(freshParams(catalogue("liste.garder"))).toEqual({ nombre: 10 });
  expect(freshParams(catalogue("liste.nouveaux"))).toEqual({ cle: "url" });
  expect(freshParams(catalogue("ia.trier"))).toEqual({ question: "Est-ce intéressant ?", texte: "{titre}" });
  expect(freshParams(catalogue("source.page"))).toEqual({});
});

test("placeLibre shifts below the displayed blocks", () => {
  expect(freeSlot({ x: 10, y: 0 }, [])).toEqual({ x: 10, y: 0 });
  expect(freeSlot({ x: 10, y: 0 }, [{ x: 0, y: 0 }, { x: 0, y: 110 }])).toEqual({ x: 10, y: 220 });
});

// Fix round 1 (review of task 9)

/** Invalid draft (unlinked block), then the agent changes `garder` on disk: the banner offers its version. */
async function withBanner() {
  const f = fake(livre());
  const e = await opened(f);
  const id = await e.ajouter(catalogue("liste.garder"), { x: 0, y: 300 });
  await wait();
  const agent = livre();
  agent.blocs[0]!.parametres = { source: "b.mjs" };
  f.etat.disque = agent;
  await e.relire();
  expect(e.bandeau).toBe("proposer");
  return { f, e, id };
}

test("I1: a gesture during the banner writes nothing and the banner stays; « Garder la mienne » sends the draft", async () => {
  const { f, e, id } = await withBanner();
  e.modifier((b) => relier(b, "garder", id));
  await wait();
  expect(f.ecritures).toEqual([]);
  expect(e.bandeau).toBe("proposer");
  expect(e.etatEnregistrement).toEqual({ invalide: AWAITING_CHOICE });
  expect((f.etat.disque as Draft).blocs[0]!.parametres).toEqual({ source: "b.mjs" });
  e.garderLaMienne();
  await wait();
  expect(e.bandeau).toBeNull();
  expect(f.ecritures).toHaveLength(1);
  expect(f.ecritures[0]!.liens).toContainEqual({ de: "garder", vers: id });
  expect(f.ecritures[0]!.blocs[0]!.parametres).toEqual({ source: "a.mjs" });
  expect(e.etatEnregistrement).toBe("enregistre");
});

test("I1: a gesture during the banner, then « Prendre sa version »: the kept draft is dropped", async () => {
  const { f, e, id } = await withBanner();
  e.modifier((b) => relier(b, "garder", id));
  e.prendreVersionDisque();
  await wait();
  expect(f.ecritures).toEqual([]);
  expect(e.bandeau).toBeNull();
  expect(e.brouillon!.blocs[0]!.parametres).toEqual({ source: "b.mjs" });
  expect(e.brouillon!.blocs.map((b) => b.id)).not.toContain(id);
  expect(e.etatEnregistrement).toBe("enregistre");
});

test("I2: ⌘Z after the first move of a workflow without layout puts the block back", async () => {
  const f = fake(livre());
  const e = await opened(f);
  e.deplacer({ ...e.positions, tri: { x: 300, y: 40 } });
  await wait();
  e.annuler();
  await wait();
  expect(e.positions.tri).toEqual({ x: 260, y: 0 });
  expect((f.etat.disque as Draft).blocs.find((b) => b.id === "tri")!.position).toEqual({ x: 0, y: 0 });
  e.retablir();
  expect(e.positions.tri).toEqual({ x: 300, y: 40 });
});

test("M2: relire during an in-flight save ignores the echo of the draft sent", async () => {
  const f = fake(livre());
  const e = await opened(f);
  f.etat.suspendu = true;
  e.deplacer({ ...e.positions, tri: { x: 300, y: 40 } });
  await wait();
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
  await wait();
  await wait();
  expect(e.etatEnregistrement).toBe("enregistre");
});

test("M3: the edition of a widget that left the home is forgotten; a reused id starts from scratch", () => {
  const { depot } = fake(livre());
  const a = createEdit("parti", depot);
  const b = createEdit("reste", depot);
  forgetEdits(["reste"]);
  expect(createEdit("parti", depot)).not.toBe(a);
  expect(createEdit("reste", depot)).toBe(b);
});

test("M4: with no free file name (read error) or no template write, the Code block is not added", async () => {
  const f = fake(livre());
  const e = await opened(f);
  f.etat.erreurCode = true;
  expect(await e.ajouter(catalogue("code"), { x: 0, y: 300 })).toBe("");
  expect(e.brouillon!.blocs.map((b) => b.id)).toEqual(["garder", "tri", "sortie"]);
  expect(e.etatEnregistrement).toEqual({ erreur: "aucun nom de fichier libre pour le bloc Code" });
  f.etat.erreurCode = false;
  f.etat.refusCode = true;
  expect(await e.ajouter(catalogue("code"), { x: 0, y: 300 })).toBe("");
  expect(e.brouillon!.blocs.map((b) => b.id)).toEqual(["garder", "tri", "sortie"]);
  expect(e.etatEnregistrement).toEqual({ erreur: "Écriture impossible" });
  await wait();
  expect(f.ecritures).toEqual([]);
  expect(Object.keys(f.etat.fichiers)).toEqual([]);
});

// Fix round 2

test("N1: a draft queued behind an in-flight save is kept if the banner appears in the meantime", async () => {
  const f = fake(livre());
  const e = await opened(f);
  f.etat.suspendu = true;
  e.deplacer({ ...e.positions, tri: { x: 300, y: 40 } });
  await wait();
  e.deplacer({ ...e.positions, tri: { x: 320, y: 60 } });
  const agent = livre();
  agent.blocs[0]!.parametres = { source: "b.mjs" };
  f.etat.disque = agent;
  await e.relire();
  expect(e.bandeau).toBe("proposer");
  f.liberer();
  await wait();
  await wait();
  // Only the draft already in flight left; the queued one waits for the choice.
  expect(f.ecritures).toHaveLength(1);
  expect(f.ecritures[0]!.blocs.find((b) => b.id === "tri")!.position).toEqual({ x: 300, y: 40 });
  expect(e.bandeau).toBe("proposer");
  expect(e.etatEnregistrement).toEqual({ invalide: AWAITING_CHOICE });
  // Taking its version also drops the queued draft.
  e.prendreVersionDisque();
  await wait();
  expect(f.ecritures).toHaveLength(1);
  expect(e.brouillon!.blocs[0]!.parametres).toEqual({ source: "b.mjs" });
});

test("N2: a save that succeeds during the banner leaves the header waiting for the choice", async () => {
  const f = fake(livre());
  const e = await opened(f);
  f.etat.suspendu = true;
  e.deplacer({ ...e.positions, tri: { x: 300, y: 40 } });
  await wait();
  const agent = livre();
  agent.blocs[0]!.parametres = { source: "b.mjs" };
  f.etat.disque = agent;
  await e.relire();
  expect(e.bandeau).toBe("proposer");
  f.liberer();
  await wait();
  await wait();
  expect(e.bandeau).toBe("proposer");
  expect(e.etatEnregistrement).toEqual({ invalide: AWAITING_CHOICE });
});

test("N1: a read error on the first name stops the search (never a random next name)", async () => {
  const f = fake(livre());
  const e = await opened(f);
  f.etat.erreurCode = ["code.mjs"];
  expect(await e.ajouter(catalogue("code"), { x: 0, y: 300 })).toBe("");
  expect(e.brouillon!.blocs.map((b) => b.id)).toEqual(["garder", "tri", "sortie"]);
  expect(Object.keys(f.etat.fichiers)).toEqual([]);
});

test("N2: « Prendre sa version » before the end of an in-flight save also drops the queued draft", async () => {
  const f = fake(livre());
  const e = await opened(f);
  f.etat.suspendu = true;
  e.deplacer({ ...e.positions, tri: { x: 300, y: 40 } });
  await wait();
  e.deplacer({ ...e.positions, tri: { x: 320, y: 60 } });
  const agent = livre();
  agent.blocs[0]!.parametres = { source: "b.mjs" };
  f.etat.disque = agent;
  await e.relire();
  e.prendreVersionDisque();
  f.liberer();
  await wait();
  await wait();
  expect(f.ecritures).toHaveLength(1);
  expect(f.ecritures[0]!.blocs.find((b) => b.id === "tri")!.position).toEqual({ x: 300, y: 40 });
});

test("T10: keystrokes in the same field (same merge key) make a single history entry", async () => {
  const f = fake(livre());
  const e = await opened(f);
  const threshold = (s: number) => (b: Draft) => set(b, "tri", { ...b.blocs.find((x) => x.id === "tri")!.parametres, seuil: s });
  e.modifier(threshold(0.6), "tri/seuil/1");
  await wait();
  e.modifier(threshold(0.7), "tri/seuil/1");
  await wait();
  expect(f.ecritures.at(-1)!.blocs.find((b) => b.id === "tri")!.parametres.seuil).toBe(0.7);
  // Another session on the same field is another entry.
  e.modifier(threshold(0.8), "tri/seuil/2");
  await wait();
  e.annuler();
  expect(e.brouillon!.blocs.find((b) => b.id === "tri")!.parametres.seuil).toBe(0.7);
  e.annuler();
  expect(e.brouillon!.blocs.find((b) => b.id === "tri")!.parametres.seuil).toBeUndefined();
  // After an undo, the same key no longer merges with the previous state.
  e.modifier(threshold(0.9), "tri/seuil/2");
  e.annuler();
  expect(e.brouillon!.blocs.find((b) => b.id === "tri")!.parametres.seuil).toBeUndefined();
});

test("source of a code block to a missing file: refused; once the code is saved, the draft restarts", async () => {
  const f = fake(livre(), { "a.mjs": "x" });
  const save = f.depot.enregistrer;
  // Like the kernel: a code block whose file is missing is refused, block named.
  f.depot.enregistrer = async (id, b) => {
    const manque = b.blocs.find((x) => x.type === "code" && !(String(x.parametres.source) in f.etat.fichiers));
    if (manque) return { ok: false, erreur: `Non enregistré : fichier ${String(manque.parametres.source)} absent`, bloc: manque.id, avertissements: [] };
    return save(id, b);
  };
  const e = await opened(f);
  e.modifier((b) => set(b, "garder", { source: "b.mjs" }));
  await wait();
  expect(e.etatEnregistrement).toEqual({ invalide: "fichier b.mjs absent", bloc: "garder" });
  expect(f.ecritures).toEqual([]);

  // Another saved file triggers nothing.
  f.etat.fichiers["c.mjs"] = "y";
  e.codeEnregistre("c.mjs");
  await wait();
  expect(f.ecritures).toEqual([]);

  f.etat.fichiers["b.mjs"] = CODE_MODEL;
  e.codeEnregistre("b.mjs");
  expect(e.etatEnregistrement).toBe("en-cours");
  await wait();
  expect(e.etatEnregistrement).toBe("enregistre");
  expect(f.ecritures.map((b) => b.blocs[0]!.parametres.source)).toEqual(["b.mjs"]);

  // Already saved: a new save of the code sends nothing.
  e.codeEnregistre("b.mjs");
  await wait();
  expect(f.ecritures).toHaveLength(1);
});
