import { blockCatalog, validateWorkflow, implicitWorkflow } from "@webaios/kernel";
import { expect, test } from "vitest";
import type { Draft, WorkflowEdit } from "../../shared/api";
import { CODE_MODEL, freshParams, freeSlot } from "../../ui/builder/add";
import { set, link } from "../../ui/builder/draft";
import { createEdit, Edit, AWAITING_CHOICE, forgetEdits, type Depot } from "../../ui/builder/edit.svelte";

const block = (id: string, type: string, params: Record<string, unknown> = {}) => ({ id, type, position: { x: 0, y: 0 }, params: params });
/** Workflow shipped without positions. */
const shipped = (): Draft => ({
  version: 1,
  blocks: [block("garder", "code", { source: "a.mjs" }), block("tri", "ai.sort", { question: "?", text: "{t}" }), block("sortie", "output", { to: "widget" })],
  links: [
    { from: "garder", to: "tri" },
    { from: "tri", to: "sortie" },
  ],
});
const catalog = (type: string) => blockCatalog().find((c) => c.type === type)!;
const wait = () => new Promise((r) => setTimeout(r, 0));

/** Fake repository: an in-memory `workflow.json`, checked by the real validator; keeps a trace of the writes. */
function fake(initial: unknown, files: Record<string, string> = {}) {
  const state = {
    disk: structuredClone(initial) as unknown,
    readable: true,
    notFound: false,
    files: { ...files },
    /** Code read error; refusal to write the code; saves suspended until `liberer()`. */
    codeError: false as boolean | string[],
    denialCode: false,
    suspended: false,
  };
  const pending: (() => void)[] = [];
  const writes: Draft[] = [];
  const reading = (): WorkflowEdit | null => {
    if (state.notFound) return null;
    const raw = state.readable ? structuredClone(state.disk) : null;
    const v = raw === null ? { ok: false as const, error: "Workflow invalide : JSON coupé" } : validateWorkflow(structuredClone(raw));
    return {
      origin: "fichier",
      raw: raw,
      validation: v.ok ? { ok: true } : { ok: false, error: v.error, ...(v.block ? { block: v.block } : {}) },
      warnings: [],
      widget: { name: "Essai", account: [], public: [], config: {}, web: false, harvest: null },
    };
  };
  const repo: Depot = {
    read: async () => reading(),
    save: async (_id, b) => {
      if (state.suspended) await new Promise<void>((ok) => pending.push(ok));
      const v = validateWorkflow(structuredClone(b));
      if (!v.ok) return { ok: false, error: v.error, ...(v.block ? { block: v.block } : {}), warnings: [] };
      writes.push(structuredClone(b));
      state.disk = structuredClone(b);
      return { ok: true, written: true, memoryErased: [], warnings: [] };
    },
    readCode: async (_id, name) => (state.codeError === true || (Array.isArray(state.codeError) && state.codeError.includes(name)) ? { error: "Fichier illisible" } : name in state.files ? { text: state.files[name]! } : { absent: true }),
    saveCode: async (_id, name, text) => {
      if (state.denialCode) return { ok: false, error: "Écriture impossible" };
      state.files[name] = text;
      return { ok: true };
    },
  };
  const release = () => {
    state.suspended = false;
    for (const ok of pending.splice(0)) ok();
  };
  return { depot: repo, state: state, writes: writes, release: release };
}

async function opened(f: ReturnType<typeof fake>): Promise<Edit> {
  const e = new Edit("essai", f.depot);
  await e.open();
  return e;
}

test("opening a workflow shipped without positions lays it out in columns and writes nothing", async () => {
  const f = fake(shipped());
  const e = await opened(f);
  expect(e.loading).toBe("pret");
  expect(e.recordingState).toBe("enregistre");
  expect(e.positions).toEqual({ garder: { x: 0, y: 0 }, tri: { x: 260, y: 0 }, sortie: { x: 520, y: 0 } });
  e.reorder();
  await e.review();
  await wait();
  expect(f.writes).toEqual([]);
});

test("the first move saves the displayed position of all blocks; a zero move writes nothing", async () => {
  const f = fake(shipped());
  const e = await opened(f);
  e.move({ ...e.positions });
  await wait();
  expect(f.writes).toEqual([]);
  e.move({ ...e.positions, tri: { x: 300, y: 40 } });
  await wait();
  expect(f.writes).toHaveLength(1);
  expect(Object.fromEntries(f.writes[0]!.blocks.map((b) => [b.id, b.position]))).toEqual({
    garder: { x: 0, y: 0 },
    tri: { x: 300, y: 40 },
    sortie: { x: 520, y: 0 },
  });
  expect(e.positions.sortie).toEqual({ x: 520, y: 0 });
});

test("a new unlinked block is « non enregistré : entrée manquante »; linked, it saves; ⌘Z goes back and saves again", async () => {
  const f = fake(shipped());
  const e = await opened(f);
  const id = await e.add(catalog("list.dedupe"), { x: 0, y: 300 });
  await wait();
  expect(id).toBe("list-dedupe");
  expect(e.recordingState).toMatchObject({ invalid: expect.stringContaining("entrée manquante"), block: id });
  expect(e.validation).toMatchObject({ ok: false, block: id });
  expect(f.writes).toEqual([]);
  e.edit((b) => link(b, "garder", id));
  await wait();
  expect(e.recordingState).toBe("enregistre");
  expect(f.writes.at(-1)!.blocks.find((b) => b.id === id)!.params).toEqual({ keys: ["url"] });
  e.cancel();
  await wait();
  expect(e.recordingState).toMatchObject({ invalid: expect.stringContaining("entrée manquante") });
  expect(f.writes).toHaveLength(1);
  e.cancel();
  await wait();
  expect(e.recordingState).toBe("enregistre");
  expect(f.writes.at(-1)!.blocks.map((b) => b.id)).toEqual(["garder", "tri", "sortie"]);
  // Displayed positions do not jump when going back to the workflow without layout.
  expect(e.positions.tri).toEqual({ x: 260, y: 0 });
  e.restore();
  expect(e.draft!.blocks.map((b) => b.id)).toContain(id);
});

test("a new code block gets its template file (never an existing file) before being saved", async () => {
  const f = fake(shipped(), { "code.mjs": "// de l'agent" });
  const e = await opened(f);
  const id = await e.add(catalog("code"), { x: 0, y: 300 });
  await wait();
  expect(id).toBe("code");
  expect(f.state.files["code.mjs"]).toBe("// de l'agent");
  expect(f.state.files["code-2.mjs"]).toBe(CODE_MODEL);
  expect(f.writes.at(-1)!.blocks.find((b) => b.id === "code")!.params).toEqual({ source: "code-2.mjs" });
  expect(e.recordingState).toBe("enregistre");
});

test("relire: the echo of a save is ignored; an agent version is adopted without writing anything", async () => {
  const f = fake(shipped());
  const e = await opened(f);
  e.move({ ...e.positions, tri: { x: 300, y: 40 } });
  await e.review();
  await wait();
  expect(e.banner).toBeNull();
  const agent = structuredClone(f.state.disk) as Draft;
  agent.blocks[0]!.params = { source: "b.mjs" };
  f.state.disk = agent;
  await e.review();
  expect(e.banner).toBeNull();
  expect(e.draft!.blocks[0]!.params).toEqual({ source: "b.mjs" });
  expect(f.writes).toHaveLength(1);
});

test("relire with an invalid draft offers the agent's version; take or keep", async () => {
  const f = fake(shipped());
  const e = await opened(f);
  await e.add(catalog("list.keep"), { x: 0, y: 300 });
  await wait();
  const agent = shipped();
  agent.blocks[0]!.params = { source: "b.mjs" };
  f.state.disk = agent;
  await e.review();
  expect(e.banner).toBe("proposer");
  expect(e.draft!.blocks.map((b) => b.id)).toContain("list-keep");
  e.keepMine();
  expect(e.banner).toBeNull();
  await e.review();
  expect(e.banner).toBeNull();
  agent.blocks[0]!.params = { source: "c.mjs" };
  f.state.disk = structuredClone(agent);
  await e.review();
  expect(e.banner).toBe("proposer");
  e.takeDiskVersion();
  expect(e.banner).toBeNull();
  expect(e.draft!.blocks.map((b) => b.id)).toEqual(["garder", "tri", "sortie"]);
  expect(e.recordingState).toBe("enregistre");
  await wait();
  expect(f.writes).toEqual([]);
});

test("relire: cut-off JSON → « illisible » banner without touching the canvas; widget not found for a moment → canvas kept", async () => {
  const f = fake(shipped());
  const e = await opened(f);
  const before = e.draft;
  f.state.readable = false;
  await e.review();
  expect(e.banner).toBe("illisible");
  expect(e.draft).toBe(before);
  f.state.readable = true;
  f.state.notFound = true;
  await e.review();
  expect(e.draft).toBe(before);
  expect(e.loading).toBe("pret");
  f.state.notFound = false;
  await e.review();
  expect(e.banner).toBeNull();
});

test("on first open: not found, or unreadable with the error", async () => {
  const absent = fake(shipped());
  absent.state.notFound = true;
  expect((await opened(absent)).loading).toBe("introuvable");
  const cut = fake(shipped());
  cut.state.readable = false;
  expect((await opened(cut)).loading).toEqual({ unreadable: "Workflow invalide : JSON coupé" });
});

test("the implicit workflow (Gmail) opens laid out, without a write", async () => {
  const f = fake(implicitWorkflow());
  const e = await opened(f);
  expect(e.positions).toEqual({ harvest: { x: 0, y: 0 }, output: { x: 260, y: 0 } });
  e.move({ ...e.positions });
  e.edit((b) => link(b, "sortie", "recolte"));
  await wait();
  expect(f.writes).toEqual([]);
});

test("one edition per widget in the window", () => {
  const { depot } = fake(shipped());
  expect(createEdit("w1", depot)).toBe(createEdit("w1", depot));
  expect(createEdit("w1", depot)).not.toBe(createEdit("w2", depot));
});

test("new parameters: neutral values for required fields, no invented address", () => {
  expect(freshParams(catalog("list.keep"))).toEqual({ count: 10 });
  expect(freshParams(catalog("list.new"))).toEqual({ key: "url" });
  expect(freshParams(catalog("ai.sort"))).toEqual({ question: "Est-ce intéressant ?", text: "{title}" });
  expect(freshParams(catalog("source.page"))).toEqual({});
});

test("freeSlot shifts below the displayed blocks", () => {
  expect(freeSlot({ x: 10, y: 0 }, [])).toEqual({ x: 10, y: 0 });
  expect(freeSlot({ x: 10, y: 0 }, [{ x: 0, y: 0 }, { x: 0, y: 110 }])).toEqual({ x: 10, y: 220 });
});

// Fix round 1 (review of task 9)

/** Invalid draft (unlinked block), then the agent changes `garder` on disk: the banner offers its version. */
async function withBanner() {
  const f = fake(shipped());
  const e = await opened(f);
  const id = await e.add(catalog("list.keep"), { x: 0, y: 300 });
  await wait();
  const agent = shipped();
  agent.blocks[0]!.params = { source: "b.mjs" };
  f.state.disk = agent;
  await e.review();
  expect(e.banner).toBe("proposer");
  return { f, e, id };
}

test("I1: a gesture during the banner writes nothing and the banner stays; « Garder la mienne » sends the draft", async () => {
  const { f, e, id } = await withBanner();
  e.edit((b) => link(b, "garder", id));
  await wait();
  expect(f.writes).toEqual([]);
  expect(e.banner).toBe("proposer");
  expect(e.recordingState).toEqual({ invalid: AWAITING_CHOICE });
  expect((f.state.disk as Draft).blocks[0]!.params).toEqual({ source: "b.mjs" });
  e.keepMine();
  await wait();
  expect(e.banner).toBeNull();
  expect(f.writes).toHaveLength(1);
  expect(f.writes[0]!.links).toContainEqual({ from: "garder", to: id });
  expect(f.writes[0]!.blocks[0]!.params).toEqual({ source: "a.mjs" });
  expect(e.recordingState).toBe("enregistre");
});

test("I1: a gesture during the banner, then « Prendre sa version »: the kept draft is dropped", async () => {
  const { f, e, id } = await withBanner();
  e.edit((b) => link(b, "garder", id));
  e.takeDiskVersion();
  await wait();
  expect(f.writes).toEqual([]);
  expect(e.banner).toBeNull();
  expect(e.draft!.blocks[0]!.params).toEqual({ source: "b.mjs" });
  expect(e.draft!.blocks.map((b) => b.id)).not.toContain(id);
  expect(e.recordingState).toBe("enregistre");
});

test("I2: ⌘Z after the first move of a workflow without layout puts the block back", async () => {
  const f = fake(shipped());
  const e = await opened(f);
  e.move({ ...e.positions, tri: { x: 300, y: 40 } });
  await wait();
  e.cancel();
  await wait();
  expect(e.positions.tri).toEqual({ x: 260, y: 0 });
  expect((f.state.disk as Draft).blocks.find((b) => b.id === "tri")!.position).toEqual({ x: 0, y: 0 });
  e.restore();
  expect(e.positions.tri).toEqual({ x: 300, y: 40 });
});

test("M2: relire during an in-flight save ignores the echo of the draft sent", async () => {
  const f = fake(shipped());
  const e = await opened(f);
  f.state.suspended = true;
  e.move({ ...e.positions, tri: { x: 300, y: 40 } });
  await wait();
  // A second gesture waits its turn while the first is in flight.
  e.move({ ...e.positions, tri: { x: 320, y: 60 } });
  // The disk already holds the first draft (written, response not yet received).
  const inFlight = structuredClone(e.draft!);
  inFlight.blocks.find((b) => b.id === "tri")!.position = { x: 300, y: 40 };
  f.state.disk = inFlight;
  await e.review();
  expect(e.banner).toBeNull();
  expect(e.positions.tri).toEqual({ x: 320, y: 60 });
  f.release();
  await wait();
  await wait();
  expect(e.recordingState).toBe("enregistre");
});

test("M3: the edition of a widget that left the home is forgotten; a reused id starts from scratch", () => {
  const { depot } = fake(shipped());
  const a = createEdit("parti", depot);
  const b = createEdit("reste", depot);
  forgetEdits(["reste"]);
  expect(createEdit("parti", depot)).not.toBe(a);
  expect(createEdit("reste", depot)).toBe(b);
});

test("M4: with no free file name (read error) or no template write, the Code block is not added", async () => {
  const f = fake(shipped());
  const e = await opened(f);
  f.state.codeError = true;
  expect(await e.add(catalog("code"), { x: 0, y: 300 })).toBe("");
  expect(e.draft!.blocks.map((b) => b.id)).toEqual(["garder", "tri", "sortie"]);
  expect(e.recordingState).toEqual({ error: "aucun nom de fichier libre pour le bloc Code" });
  f.state.codeError = false;
  f.state.denialCode = true;
  expect(await e.add(catalog("code"), { x: 0, y: 300 })).toBe("");
  expect(e.draft!.blocks.map((b) => b.id)).toEqual(["garder", "tri", "sortie"]);
  expect(e.recordingState).toEqual({ error: "Écriture impossible" });
  await wait();
  expect(f.writes).toEqual([]);
  expect(Object.keys(f.state.files)).toEqual([]);
});

// Fix round 2

test("N1: a draft queued behind an in-flight save is kept if the banner appears in the meantime", async () => {
  const f = fake(shipped());
  const e = await opened(f);
  f.state.suspended = true;
  e.move({ ...e.positions, tri: { x: 300, y: 40 } });
  await wait();
  e.move({ ...e.positions, tri: { x: 320, y: 60 } });
  const agent = shipped();
  agent.blocks[0]!.params = { source: "b.mjs" };
  f.state.disk = agent;
  await e.review();
  expect(e.banner).toBe("proposer");
  f.release();
  await wait();
  await wait();
  // Only the draft already in flight left; the queued one waits for the choice.
  expect(f.writes).toHaveLength(1);
  expect(f.writes[0]!.blocks.find((b) => b.id === "tri")!.position).toEqual({ x: 300, y: 40 });
  expect(e.banner).toBe("proposer");
  expect(e.recordingState).toEqual({ invalid: AWAITING_CHOICE });
  // Taking its version also drops the queued draft.
  e.takeDiskVersion();
  await wait();
  expect(f.writes).toHaveLength(1);
  expect(e.draft!.blocks[0]!.params).toEqual({ source: "b.mjs" });
});

test("N2: a save that succeeds during the banner leaves the header waiting for the choice", async () => {
  const f = fake(shipped());
  const e = await opened(f);
  f.state.suspended = true;
  e.move({ ...e.positions, tri: { x: 300, y: 40 } });
  await wait();
  const agent = shipped();
  agent.blocks[0]!.params = { source: "b.mjs" };
  f.state.disk = agent;
  await e.review();
  expect(e.banner).toBe("proposer");
  f.release();
  await wait();
  await wait();
  expect(e.banner).toBe("proposer");
  expect(e.recordingState).toEqual({ invalid: AWAITING_CHOICE });
});

test("N1: a read error on the first name stops the search (never a random next name)", async () => {
  const f = fake(shipped());
  const e = await opened(f);
  f.state.codeError = ["code.mjs"];
  expect(await e.add(catalog("code"), { x: 0, y: 300 })).toBe("");
  expect(e.draft!.blocks.map((b) => b.id)).toEqual(["garder", "tri", "sortie"]);
  expect(Object.keys(f.state.files)).toEqual([]);
});

test("N2: « Prendre sa version » before the end of an in-flight save also drops the queued draft", async () => {
  const f = fake(shipped());
  const e = await opened(f);
  f.state.suspended = true;
  e.move({ ...e.positions, tri: { x: 300, y: 40 } });
  await wait();
  e.move({ ...e.positions, tri: { x: 320, y: 60 } });
  const agent = shipped();
  agent.blocks[0]!.params = { source: "b.mjs" };
  f.state.disk = agent;
  await e.review();
  e.takeDiskVersion();
  f.release();
  await wait();
  await wait();
  expect(f.writes).toHaveLength(1);
  expect(f.writes[0]!.blocks.find((b) => b.id === "tri")!.position).toEqual({ x: 300, y: 40 });
});

test("T10: keystrokes in the same field (same merge key) make a single history entry", async () => {
  const f = fake(shipped());
  const e = await opened(f);
  const threshold = (s: number) => (b: Draft) => set(b, "tri", { ...b.blocks.find((x) => x.id === "tri")!.params, threshold: s });
  e.edit(threshold(0.6), "tri/seuil/1");
  await wait();
  e.edit(threshold(0.7), "tri/seuil/1");
  await wait();
  expect(f.writes.at(-1)!.blocks.find((b) => b.id === "tri")!.params.threshold).toBe(0.7);
  // Another session on the same field is another entry.
  e.edit(threshold(0.8), "tri/seuil/2");
  await wait();
  e.cancel();
  expect(e.draft!.blocks.find((b) => b.id === "tri")!.params.threshold).toBe(0.7);
  e.cancel();
  expect(e.draft!.blocks.find((b) => b.id === "tri")!.params.threshold).toBeUndefined();
  // After an undo, the same key no longer merges with the previous state.
  e.edit(threshold(0.9), "tri/seuil/2");
  e.cancel();
  expect(e.draft!.blocks.find((b) => b.id === "tri")!.params.threshold).toBeUndefined();
});

test("source of a code block to a missing file: refused; once the code is saved, the draft restarts", async () => {
  const f = fake(shipped(), { "a.mjs": "x" });
  const save = f.depot.save;
  // Like the kernel: a code block whose file is missing is refused, block named.
  f.depot.save = async (id, b) => {
    const missing = b.blocks.find((x) => x.type === "code" && !(String(x.params.source) in f.state.files));
    if (missing) return { ok: false, error: `Non enregistré : fichier ${String(missing.params.source)} absent`, block: missing.id, warnings: [] };
    return save(id, b);
  };
  const e = await opened(f);
  e.edit((b) => set(b, "garder", { source: "b.mjs" }));
  await wait();
  expect(e.recordingState).toEqual({ invalid: "fichier b.mjs absent", block: "garder" });
  expect(f.writes).toEqual([]);

  // Another saved file triggers nothing.
  f.state.files["c.mjs"] = "y";
  e.savedCode("c.mjs");
  await wait();
  expect(f.writes).toEqual([]);

  f.state.files["b.mjs"] = CODE_MODEL;
  e.savedCode("b.mjs");
  expect(e.recordingState).toBe("en-cours");
  await wait();
  expect(e.recordingState).toBe("enregistre");
  expect(f.writes.map((b) => b.blocks[0]!.params.source)).toEqual(["b.mjs"]);

  // Already saved: a new save of the code sends nothing.
  e.savedCode("b.mjs");
  await wait();
  expect(f.writes).toHaveLength(1);
});
