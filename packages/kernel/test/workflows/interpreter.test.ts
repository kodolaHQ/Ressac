import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { tempFolder } from "../helpers/temp.js";
import type { BlocksMemory } from "../../src/workflows/memory.js";
import { implicitWorkflow } from "../../src/workflows/validate.js";
import { ENGINE, SCRIPT, block, chain, launch, output } from "../helpers/engine.js";
import { SEARCHES_CAP, SEARCHES_STOPPED } from "../../src/workflows/access.js";
import { SEARCH_DENIED } from "../../src/workflows/duckduckgo.js";

// The engine is the container's JavaScript: imported as is, without types.
const { runWorkflow } = await import(pathToFileURL(join(ENGINE, "interpreter.mjs")).href);
const { default: newList } = await import(pathToFileURL(join(ENGINE, "blocks", "list-new.mjs")).href);
const { default: keepList } = await import(pathToFileURL(join(ENGINE, "blocks", "list-keep.mjs")).href);
const { ItemNotRun: NotRunElement } = await import(pathToFileURL(join(ENGINE, "errors.mjs")).href);

describe("interpreter (in the container)", () => {
  it("runs the blocks in order and sends debut then fin for each block before fin", async () => {
    const r = await launch({
      workflow: {
        version: 1,
        // In the array's disorder: the order comes from the links.
        blocks: [output, block("garder", "list.keep", { count: 2 }), block("src", "code", { source: "src.mjs" })],
        links: chain("src", "garder", "sortie"),
      },
      files: { "src.mjs": `export default async () => [1, 2, 3];` },
    });
    expect(r.code).toBe(0);
    expect(r.traces.map((l) => (l.t === "block" ? `${l.step}:${l.id}` : l.t))).toEqual([
      "start:src", "end:src",
      "start:garder", "end:garder",
      "start:sortie", "end:sortie",
      "memory", "end",
    ]);
    expect(r.blockEnd("src")).toEqual({ t: "block", id: "src", step: "end", status: "succeeded", output: [1, 2, 3] });
    expect(r.blockEnd("garder").output).toEqual([1, 2]);
    expect(r.terminal).toEqual({ t: "end", data: [1, 2] });
  });

  it("a block with several inputs receives { id: output }", async () => {
    const r = await launch({
      workflow: {
        version: 1,
        blocks: [
          block("a", "code", { source: "a.mjs" }),
          block("b", "code", { source: "b.mjs" }),
          block("tout", "code", { source: "tout.mjs" }),
          output,
        ],
        links: [{ from: "a", to: "tout" }, { from: "b", to: "tout" }, { from: "tout", to: "sortie" }],
      },
      files: {
        "a.mjs": `export default async (input) => ({ inputOfA: input });`,
        "b.mjs": `export default async () => "B";`,
        "tout.mjs": `export default async (entree) => entree;`,
      },
    });
    expect(r.terminal).toEqual({ t: "end", data: { a: { inputOfA: null }, b: "B" } });
  });

  it("code receives (entree, ressac) with config, precedent, maintenant, journal; its log lines are attached to the block and also go to stderr", async () => {
    const r = await launch({
      workflow: {
        version: 1,
        blocks: [block("src", "code", { source: "src.mjs" }), block("lire", "code", { source: "lire.mjs" }), output],
        links: chain("src", "lire", "sortie"),
      },
      config: { city: "Bordeaux" },
      previous: { before: 1 },
      files: {
        "src.mjs": `export default async () => "x";`,
        "lire.mjs": `export default async (input, w) => {
          w.log("bonjour", { a: 1 });
          const p = await w.readPage("https://a.fr/");
          return { entry: input, config: w.config, previous: w.previous, now: w.now, title: p.title };
        };`,
      },
      reply: (a) => ({ ok: { url: a.a.url, title: "T", text: "", links: [] } }),
    });
    expect(r.terminal.data).toEqual({
      entry: "x",
      config: { city: "Bordeaux" },
      previous: { before: 1 },
      now: "2026-10-29T10:00:00.000Z",
      title: "T",
    });
    expect(r.lines.filter((l) => l.t === "log")).toEqual([{ t: "log", block: "lire", text: 'bonjour {"a":1}' }]);
    expect(r.stderr).toContain('bonjour {"a":1}');
    expect(r.calls[0]!.a).toEqual({ url: "https://a.fr/" });
  });

  it("code with appel: recolte calls default(ressac) as today", async () => {
    const r = await launch({
      workflow: {
        version: 1,
        blocks: [block("recolte", "code", { source: "harvest.mjs", call: "harvest" }), output],
        links: chain("recolte", "sortie"),
      },
      config: { a: 1 },
      previous: { v: 2 },
      files: {
        "harvest.mjs": `export default async (w) => ({ cfg: w.config, prev: w.previous, k: await w.kev("etat", { q: { type: "noul" } }) });`,
      },
      reply: () => ({ ok: { q: { type: "noul", noul: 0.5 } } }),
    });
    expect(r.calls.map((a) => [a.f, a.a])).toEqual([["kev", { state: "etat", questions: { q: { type: "noul" } } }]]);
    expect(r.terminal).toEqual({ t: "end", data: { cfg: { a: 1 }, prev: { v: 2 }, k: { q: { type: "noul", noul: 0.5 } } } });
  });

  it("an error thrown by the code ends the block failed and the run in echec with the same message", async () => {
    const r = await launch({
      workflow: { version: 1, blocks: [block("recolte", "code", { source: "harvest.mjs", call: "harvest" }), output], links: chain("recolte", "sortie") },
      files: { "harvest.mjs": `export default async () => { throw new Error("boum"); };` },
    });
    expect(r.blockEnd("recolte")).toEqual({ t: "block", id: "recolte", step: "end", status: "failed", error: "boum" });
    expect(r.terminal).toEqual({ t: "failure", error: "boum" });
    expect(r.lines.some((l) => l.t === "memory")).toBe(false);
  });

  it("a missing code file fails the block, the following ones are not launched, then echec", async () => {
    const r = await launch({
      workflow: {
        version: 1,
        blocks: [block("a", "code", { source: "absent.mjs" }), block("b", "list.keep", { count: 1 }), output],
        links: chain("a", "b", "sortie"),
      },
    });
    expect(r.blockEnd("a")).toMatchObject({ status: "failed", error: "fichier de code absent : absent.mjs" });
    expect(r.lines.some((l) => l.t === "block" && l.id !== "a")).toBe(false);
    expect(r.terminal).toEqual({ t: "failure", error: "fichier de code absent : absent.mjs" });
    expect(r.code).toBe(1);
  });

  it("list.new keeps only the never-seen keys and retains at most 5000 keys", async () => {
    const olds = Array.from({ length: 5000 }, (_, i) => `k${i}`);
    const r = await launch({
      workflow: {
        version: 1,
        blocks: [block("src", "code", { source: "src.mjs" }), block("nv", "list.new", { key: "url" }), output],
        links: chain("src", "nv", "sortie"),
      },
      memory: { nv: { type: "list.new", value: olds } },
      files: { "src.mjs": `export default async () => [{ url: "k4999" }, { url: "neuf" }, { url: "k0" }, { url: "autre" }];` },
    });
    expect(r.terminal.data).toEqual([{ url: "neuf" }, { url: "autre" }]);
    const m = r.lines.find((l) => l.t === "memory").memory.nv;
    expect(m.type).toBe("list.new");
    expect(m.value).toHaveLength(5000);
    const keys = m.value.map(([c]: [string, string]) => c);
    // The keys seen this time are the most recent; the oldest never seen again are forgotten.
    expect(keys.slice(-4)).toEqual(["k4999", "neuf", "k0", "autre"]);
    expect(keys).not.toContain("k1");
    expect(keys).not.toContain("k2");
    expect(keys).toContain("k3");
  });

  it("list.new: a duplicate in the same list is not new; a long key is kept cut to 500 characters", async () => {
    const lengthy = "u".repeat(800);
    const r = await launch({
      workflow: {
        version: 1,
        blocks: [block("src", "code", { source: "src.mjs" }), block("nv", "list.new", { key: "url" }), output],
        links: chain("src", "nv", "sortie"),
      },
      memory: { nv: { type: "list.new", value: ["u".repeat(500)] } },
      files: {
        "src.mjs": `export default async () => [{ url: "a", n: 1 }, { url: "a", n: 2 }, { url: "b" }, { url: ${JSON.stringify(lengthy)} }];`,
      },
    });
    expect(r.terminal.data).toEqual([{ url: "a", n: 1 }, { url: "b" }]);
    expect(r.lines.find((l) => l.t === "memory").memory.nv.value).toEqual([
      ["a", "2026-10-29T10:00:00.000Z"],
      ["b", "2026-10-29T10:00:00.000Z"],
      ["u".repeat(500), "2026-10-29T10:00:00.000Z"],
    ]);
  });

  it("liste.dedoublonner: duplicate on one of the normalized keys (utm_, www., trailing /; title accents and case)", async () => {
    const elements = [
      { title: "Été à Paris", url: "https://www.a.fr/x/?utm_source=rss&id=1" },
      { title: "Autre", url: "https://a.fr/x?id=1" }, // same normalized URL
      { title: "ete a paris!", url: "https://b.fr/y" }, // same normalized title
      { title: "Troisième", url: "https://b.fr/z" },
      { title: "Sans url" },
      { title: "Sans url 2" },
    ];
    const r = await launch({
      workflow: {
        version: 1,
        blocks: [block("src", "code", { source: "src.mjs" }), block("d", "list.dedupe", { keys: ["url", "title"] }), output],
        links: chain("src", "d", "sortie"),
      },
      files: { "src.mjs": `export default async () => ${JSON.stringify(elements)};` },
    });
    expect(r.terminal.data).toEqual([elements[0], elements[3], elements[4], elements[5]]);
  });

  it("liste.garder keeps the first N; an input that is not a list fails the block", async () => {
    const ok = await launch({
      workflow: {
        version: 1,
        blocks: [block("src", "code", { source: "src.mjs" }), block("g", "list.keep", { count: 3 }), output],
        links: chain("src", "g", "sortie"),
      },
      files: { "src.mjs": `export default async () => [5, 4, 3, 2, 1];` },
    });
    expect(ok.terminal.data).toEqual([5, 4, 3]);
    const ko = await launch({
      workflow: {
        version: 1,
        blocks: [block("src", "code", { source: "src.mjs" }), block("g", "list.keep", { count: 3 }), output],
        links: chain("src", "g", "sortie"),
      },
      files: { "src.mjs": `export default async () => ({ pas: "une liste" });` },
    });
    expect(ko.blockEnd("g")).toMatchObject({ status: "failed", error: "liste attendue en entrée" });
  });

  it("the memory sent before fin contains only the workflow's blocks, with their type; a memory of another type is ignored", async () => {
    const r = await launch({
      workflow: {
        version: 1,
        blocks: [block("src", "code", { source: "src.mjs" }), block("nv", "list.new", { key: "id" }), output],
        links: chain("src", "nv", "sortie"),
      },
      memory: {
        // Same id, other type: ignored (everything is new).
        nv: { type: "list.dedupe", value: ["1"] },
        // Block that no longer exists: forgotten.
        old: { type: "list.new", value: ["z"] },
        // Block present, same type, without a new value: kept as is.
        src: { type: "code", value: { guard: true } },
      },
      files: { "src.mjs": `export default async () => [{ id: 1 }, { id: 2 }];` },
    });
    expect(r.terminal.data).toEqual([{ id: 1 }, { id: 2 }]);
    const lines = r.lines.map((l) => l.t);
    expect(lines.indexOf("memory")).toBe(lines.indexOf("end") - 1);
    expect(r.lines.find((l) => l.t === "memory").memory).toEqual({
      src: { type: "code", value: { guard: true } },
      nv: { type: "list.new", value: [["1", "2026-10-29T10:00:00.000Z"], ["2", "2026-10-29T10:00:00.000Z"]] },
    });
  });

  it("a block output too big for a line is sent without output, with sortieTropGrosse", async () => {
    const r = await launch({
      workflow: {
        version: 1,
        blocks: [block("gros", "code", { source: "gros.mjs" }), block("taille", "code", { source: "taille.mjs" }), output],
        links: chain("gros", "taille", "sortie"),
      },
      files: {
        "gros.mjs": `export default async () => "x".repeat(4 * 1024 * 1024 + 10);`,
        "taille.mjs": `export default async (entree) => entree.length;`,
      },
    });
    expect(r.blockEnd("gros")).toEqual({ t: "block", id: "gros", step: "end", status: "succeeded", outputTooBig: true });
    expect(r.terminal).toEqual({ t: "end", data: 4 * 1024 * 1024 + 10 });
  });

  it("a debut without a workflow is refused: harvest.mjs no longer runs outside a workflow", async () => {
    const folder = await tempFolder();
    await writeFile(join(folder, "harvest.mjs"), `export default async () => ({ lance: true });`);
    const child = spawn("node", [SCRIPT, folder], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    const finished = new Promise<number | null>((ok) => child.on("close", (c) => ok(c)));
    child.stdin.write(JSON.stringify({ t: "start", previous: { v: 1 }, now: "2026-10-29T10:00:00.000Z", config: { a: 1 } }) + "\n");
    expect(await finished).toBe(1);
    expect(out.trim().split("\n").map((l) => JSON.parse(l))).toEqual([{ t: "failure", error: "start sans workflow" }]);
  });

  it("the implicit workflow of a harvest.mjs: default(ressac) with the debut config, log on stderr", async () => {
    const r = await launch({
      workflow: implicitWorkflow(),
      config: { a: 1 },
      previous: { v: 1 },
      files: { "harvest.mjs": `export default async (w) => { w.log("j"); return { cfg: w.config, prev: w.previous, when: w.now }; };` },
    });
    expect(r.terminal).toEqual({ t: "end", data: { cfg: { a: 1 }, prev: { v: 1 }, when: "2026-10-29T10:00:00.000Z" } });
    expect(r.blockEnd("harvest")).toMatchObject({ status: "succeeded" });
    expect(r.stderr).toContain("j");
  });
});

describe("interpreter: replay from a block", () => {
  it("with replay, only the relaunched blocks are traced, in order, and receive the reused outputs", async () => {
    const r = await launch({
      workflow: {
        version: 1,
        blocks: [block("src", "code", { source: "src.mjs" }), block("b", "code", { source: "b.mjs" }), output],
        links: chain("src", "b", "sortie"),
      },
      files: {
        "src.mjs": `export default async () => { throw new Error("src ne doit pas être lancé"); };`,
        "b.mjs": `export default async (input) => ({ received: input });`,
      },
      replay: { reruns: ["b", "sortie"], outputs: { src: [1, 2] } },
    });
    expect(r.code).toBe(0);
    // No trace for src, and no memory returned: the kernel keeps none for a trial.
    expect(r.traces.map((l) => (l.t === "block" ? `${l.step}:${l.id}` : l.t))).toEqual([
      "start:b", "end:b",
      "start:sortie", "end:sortie",
      "end",
    ]);
    expect(r.terminal).toEqual({ t: "end", data: { received: [1, 2] } });
  });

  it("a relaunched block with two inputs receives { id: output } mixing reuse and relaunch", async () => {
    const r = await launch({
      workflow: {
        version: 1,
        blocks: [block("a", "code", { source: "a.mjs" }), block("b", "code", { source: "b.mjs" }), block("tout", "code", { source: "tout.mjs" }), output],
        links: [{ from: "a", to: "tout" }, { from: "b", to: "tout" }, { from: "tout", to: "sortie" }],
      },
      files: {
        "a.mjs": `export default async () => { throw new Error("a ne doit pas être lancé"); };`,
        "b.mjs": `export default async () => "B relancé";`,
        "tout.mjs": `export default async (entree) => entree;`,
      },
      replay: { reruns: ["b", "tout", "sortie"], outputs: { a: { resumed: true } } },
    });
    expect(r.terminal).toEqual({ t: "end", data: { a: { resumed: true }, b: "B relancé" } });
    expect(r.lines.filter((l) => l.t === "block" && l.step === "start").map((l) => l.id)).toEqual(["b", "tout", "sortie"]);
  });

  it("without the sortie block among the relaunched ones, the data is null", async () => {
    const r = await launch({
      workflow: { version: 1, blocks: [block("a", "code", { source: "a.mjs" }), output], links: chain("a", "sortie") },
      files: { "a.mjs": `export default async () => "a";` },
      replay: { reruns: ["a"], outputs: {} },
    });
    expect(r.terminal).toEqual({ t: "end", data: null });
    expect(r.blockEnd("sortie")).toBeUndefined();
  });

  it("with replay, the interpreter ignores the received memory: list.new lets everything through, reuse reuses nothing, no block returns a memory", async () => {
    // The kernel sends an empty memory for a trial; the interpreter does not rely on it: even a received memory
    // (including that of a block not relaunched) is neither read nor returned.
    const computed: string[] = [];
    const r = await run({
      entry: "jamais lu",
      memory: {
        src: { type: "test.source", value: "ancienne" },
        nv: { type: "list.new", value: ["a", "b"] },
        b: { type: "test.resume", value: { reused: [["a", "ancien résumé"]] } },
      },
      blocks: [
        { id: "nv", type: "list.new", params: { key: "url" } },
        { id: "b", type: "test.resume", params: { field: "resume", reuse: "url" } },
        { id: "sortie", type: "output" },
      ],
      registry: {
        "list.new": newList,
        "test.resume": {
          perItem: "always",
          async processItem(ctx: any) {
            computed.push(ctx.item.url);
            return `résumé de ${ctx.item.url}`;
          },
        },
      },
      replay: { reruns: ["nv", "b", "sortie"], outputs: { src: [{ url: "a" }, { url: "b" }] } },
    });
    expect(r.error).toBeNull();
    expect(r.traces.some((l) => l.id === "src")).toBe(false);
    expect(computed).toEqual(["a", "b"]);
    expect(r.result!.data).toEqual([{ url: "a", resume: "résumé de a" }, { url: "b", resume: "résumé de b" }]);
    expect(r.result!.memory).toEqual({});
  });
});

/** Direct run of the interpreter, with a registry of test blocks. */
async function run(o: {
  blocks: { id: string; type: string; params?: Record<string, unknown> }[];
  registry: Record<string, unknown>;
  entry: unknown;
  memory?: BlocksMemory;
  deadline?: number;
  clock?: () => number;
  replay?: { reruns: string[]; outputs: Record<string, unknown> };
  progressive?: boolean;
  progress?: boolean;
  input?: string;
  /** Called on each line sent, at the moment it leaves. */
  spy?: (m: any) => void;
}) {
  const traces: any[] = [];
  const workflow = {
    blocks: [{ id: "src", type: "test.source", params: {} }, ...o.blocks.map((b) => ({ params: {}, ...b }))],
    links: chain("src", ...o.blocks.map((b) => b.id)),
    order: ["src", ...o.blocks.map((b) => b.id)],
  };
  const registry = {
    "test.source": { perItem: "no", run: async () => ({ output: o.entry }) },
    output: { perItem: "no", run: async (ctx: any) => ({ output: ctx.input }) },
    ...o.registry,
  };
  let error: Error | null = null;
  let result: { data: unknown; memory: BlocksMemory } | null = null;
  try {
    result = await runWorkflow({
      workflow,
      config: null,
      memory: o.memory ?? {},
      now: "2026-10-29T10:00:00.000Z",
      previous: null,
      folder: "/nulle-part",
      call: async () => null,
      trace: (m: unknown) => {
        o.spy?.(m);
        traces.push(m);
      },
      blocks: registry,
      ...(o.deadline !== undefined ? { deadline: o.deadline } : {}),
      ...(o.clock ? { clock: o.clock } : {}),
      ...(o.replay ? { replay: o.replay } : {}),
      ...(o.progressive !== undefined ? { progressive: o.progressive } : {}),
      ...(o.progress !== undefined ? { progress: o.progress } : {}),
      ...(o.input !== undefined ? { input: o.input } : {}),
    });
  } catch (e) {
    error = e as Error;
  }
  return {
    error: error,
    result: result,
    traces,
    blockEnd: (id: string) => traces.find((l) => l.t === "block" && l.id === id && l.step === "end"),
    log: (id: string) => traces.filter((l) => l.t === "log" && l.block === id).map((l) => l.text as string),
  };
}

const wait = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const list = (n: number) => Array.from({ length: n }, (_, i) => ({ n: i }));

describe("interpreter: input and progress (actions)", () => {
  /** A per-element block where each element takes 300 ms on the fake clock. */
  const slow = (clock: { t: number }) => ({
    "test.lent": {
      perItem: "always",
      async processItem(ctx: any) {
        await wait(1);
        clock.t += 300;
        return ctx.item.n;
      },
    },
  });

  it("with progress, a per-element block over 12 elements sends spaced avancement lines and the last one 12/12", async () => {
    const clock = { t: 0 };
    const hours: number[] = [];
    const r = await run({
      entry: list(12),
      blocks: [{ id: "b", type: "test.lent", params: { field: "v" } }, { id: "sortie", type: "output" }],
      registry: slow(clock),
      clock: () => clock.t,
      progress: true,
      spy: (m) => {
        if (m.step === "progress") hours.push(clock.t);
      },
    });
    expect(r.error).toBeNull();
    const progress = r.traces.filter((l) => l.step === "progress");
    expect(progress.every((l) => l.t === "block" && l.id === "b" && l.total === 12)).toBe(true);
    expect(progress.at(-1)).toEqual({ t: "block", id: "b", step: "progress", done: 12, total: 12 });
    // Spaced by at least PROGRESS_GAP_MS, except the last, always sent.
    for (let i = 1; i < hours.length - 1; i++) expect(hours[i]! - hours[i - 1]!).toBeGreaterThanOrEqual(1000);
    expect(progress.length).toBeGreaterThanOrEqual(2);
    expect(progress.length).toBeLessThan(12);
    const done = progress.map((l) => l.done);
    expect([...done].sort((a, b) => a - b)).toEqual(done);
    // Between the start and the end of the block.
    const hint = (f: (l: any) => boolean) => r.traces.findIndex(f);
    expect(hint((l) => l.step === "progress")).toBeGreaterThan(hint((l) => l.id === "b" && l.step === "start"));
    expect(r.traces.findLastIndex((l) => l.step === "progress")).toBeLessThan(hint((l) => l.id === "b" && l.step === "end"));
  });

  it("without progress, no avancement line", async () => {
    const clock = { t: 0 };
    const r = await run({
      entry: list(12),
      blocks: [{ id: "b", type: "test.lent", params: { field: "v" } }, { id: "sortie", type: "output" }],
      registry: slow(clock),
      clock: () => clock.t,
    });
    expect(r.error).toBeNull();
    expect(r.traces.some((l) => l.step === "progress")).toBe(false);
  });

  it("ctx.userInput is given to the code", async () => {
    const workflow = {
      version: 1,
      blocks: [block("lire", "source.page", { url: "https://www.leboncoin.fr/recherche?text={input}" }), block("c", "code", { source: "c.mjs" }), output],
      links: chain("lire", "c", "sortie"),
    };
    const files = { "c.mjs": `export default async (input, w) => ({ input: w.input ?? null, hasKey: "input" in w });` };
    const reply = (a: any) => ({ ok: { url: a.a.url, title: "", text: "", links: [] } });
    const r = await launch({ workflow, files: files, reply: reply, start: { input: "clio lyon" } });
    expect(r.terminal).toEqual({ t: "end", data: { input: "clio lyon", hasKey: true } });
    expect(r.calls[0]!.a.url).toBe("https://www.leboncoin.fr/recherche?text=clio%20lyon");
    // An engine block receives it too in its ctx.
    let view: unknown;
    await run({
      entry: null,
      blocks: [{ id: "b", type: "test.voir" }, { id: "sortie", type: "output" }],
      registry: { "test.voir": { perItem: "no", run: async (ctx: any) => ((view = ctx.userInput), { output: null }) } },
      input: "clio lyon",
    });
    expect(view).toBe("clio lyon");
    // A widget (without input): nothing new in ressac.
    const widget = await launch({ workflow: { ...workflow, blocks: [block("lire", "code", { source: "c.mjs" }), block("c", "code", { source: "c.mjs" }), output] }, files: files });
    expect(widget.terminal).toEqual({ t: "end", data: { input: null, hasKey: false } });
  });

  it("PROGRESS_GAP_MS equal in interpreter.mjs and run.ts", async () => {
    const interpreter = await import(pathToFileURL(join(ENGINE, "interpreter.mjs")).href);
    const { PROGRESS_GAP_MS } = await import("../../src/workflows/run.js");
    expect(PROGRESS_GAP_MS).toBe(1000);
    expect(interpreter.PROGRESS_GAP_MS).toBe(PROGRESS_GAP_MS);
  });
});

describe("interpreter: per-element blocks", () => {
  it("per element: two elements at a time, result under champ, order kept", async () => {
    let running = 0;
    let max = 0;
    const r = await run({
      entry: list(6),
      blocks: [{ id: "double", type: "test.double", params: { field: "d" } }, { id: "sortie", type: "output" }],
      registry: {
        "test.double": {
          perItem: "always",
          async processItem(ctx: any) {
            running++;
            max = Math.max(max, running);
            // The first ones finish after the following ones: the output order stays the input's.
            await wait(ctx.item.n < 2 ? 40 : 5);
            running--;
            return ctx.item.n * 2;
          },
        },
      },
    });
    expect(r.error).toBeNull();
    expect(max).toBe(2);
    expect(r.result!.data).toEqual(list(6).map((e) => ({ ...e, d: e.n * 2 })));
    expect(r.blockEnd("double")).toMatchObject({ status: "succeeded" });
  });

  it("per element « option »: without perItem, executer runs once on the whole input", async () => {
    const r = await run({
      entry: list(3),
      blocks: [{ id: "b", type: "test.option", params: { perItem: false, field: "x" } }, { id: "sortie", type: "output" }],
      registry: {
        "test.option": {
          perItem: "option",
          run: async (ctx: any) => ({ output: ctx.input.length }),
          processItem: async () => "élément",
        },
      },
    });
    expect(r.result!.data).toBe(3);
  });

  it("per element: an input that is not a list fails the block", async () => {
    const r = await run({
      entry: { step: "liste" },
      blocks: [{ id: "b", type: "test.x", params: { field: "x" } }, { id: "sortie", type: "output" }],
      registry: { "test.x": { perItem: "always", processItem: async () => 1 } },
    });
    expect(r.error?.message).toBe("liste attendue en entrée");
    expect(r.blockEnd("b")).toMatchObject({ status: "failed", error: "liste attendue en entrée" });
  });

  it("per element: a failing element is skipped, the block ends partial; onError echouer fails the block", async () => {
    const registry = {
      "test.x": {
        perItem: "always",
        async processItem(ctx: any) {
          if (ctx.item.n === 1) throw new Error("raté");
          return "ok";
        },
      },
    };
    const skipped = await run({
      entry: list(3),
      blocks: [{ id: "b", type: "test.x", params: { field: "r" } }, { id: "sortie", type: "output" }],
      registry: registry,
    });
    expect(skipped.result!.data).toEqual([{ n: 0, r: "ok" }, { n: 1 }, { n: 2, r: "ok" }]);
    expect(skipped.blockEnd("b")).toMatchObject({ status: "partial" });
    expect(skipped.log("b").join("\n")).toContain("raté");

    const failed = await run({
      entry: list(3),
      blocks: [{ id: "b", type: "test.x", params: { field: "r", onError: "fail" } }, { id: "sortie", type: "output" }],
      registry: registry,
    });
    expect(failed.error?.message).toBe("raté");
    expect(failed.blockEnd("b")).toMatchObject({ status: "failed", error: "raté" });
    expect(failed.traces.some((l) => l.id === "sortie")).toBe(false);
  });

  it("per element: all elements failing fail a block that asks for it, even with sauter; the others end partial; an empty list is not a failure", async () => {
    const registry = {
      "test.x": { perItem: "always", failIfAllFail: true, processItem: async () => { throw new Error("Kev indisponible"); } },
      "test.enrichir": { perItem: "always", processItem: async () => { throw new Error("page illisible"); } },
    };
    const all = await run({
      entry: list(2),
      blocks: [{ id: "b", type: "test.x", params: { field: "r" } }, { id: "sortie", type: "output" }],
      registry: registry,
    });
    expect(all.blockEnd("b")).toMatchObject({ status: "failed" });
    expect(all.error?.message).toContain("Kev indisponible");

    const enrich = await run({
      entry: list(2),
      blocks: [{ id: "b", type: "test.enrichir", params: { field: "r" } }, { id: "sortie", type: "output" }],
      registry: registry,
    });
    expect(enrich.error).toBeNull();
    expect(enrich.blockEnd("b")).toMatchObject({ status: "partial" });
    expect(enrich.result!.data).toEqual(list(2));
    expect(enrich.log("b").join("\n")).toContain("page illisible");

    const empty = await run({
      entry: [],
      blocks: [{ id: "b", type: "test.x", params: { field: "r" } }, { id: "sortie", type: "output" }],
      registry: registry,
    });
    expect(empty.error).toBeNull();
    expect(empty.blockEnd("b")).toMatchObject({ status: "succeeded", output: [] });
  });

  it("per element: a missing template value leaves the element without a field, without an error; in simple mode the output is null", async () => {
    const registry = {
      "test.gabarit": {
        perItem: "option",
        run: async (ctx: any) => ({ output: ctx.fill("{config.city}").text }),
        processItem: async (ctx: any) => ctx.fill("url={url}", { url: true }).text,
      },
    };
    const byElement = await run({
      // An old value under `champ` does not survive an element without a value this time.
      entry: [{ url: "a b", u: "ancienne" }, { other: 1, u: "ancienne" }],
      blocks: [{ id: "b", type: "test.gabarit", params: { perItem: true, field: "u" } }, { id: "sortie", type: "output" }],
      registry: registry,
    });
    expect(byElement.result!.data).toEqual([{ url: "a b", u: "url=a%20b" }, { other: 1 }]);
    expect(byElement.blockEnd("b")).toMatchObject({ status: "succeeded" });
    expect(byElement.log("b").join("\n")).toContain("valeur absente : url");

    const simple = await run({
      entry: null,
      blocks: [{ id: "b", type: "test.gabarit", params: { perItem: false, field: "u" } }, { id: "sortie", type: "output" }],
      registry: registry,
    });
    expect(simple.blockEnd("b")).toEqual({ t: "block", id: "b", step: "end", status: "succeeded", output: null });
    expect(simple.log("b")).toEqual(["valeur absente : config.city"]);
  });

  it("per element: an optional marker {chemin?} that is absent gives an empty string, present it is filled; the element is processed", async () => {
    const registry = {
      "test.gabarit": { perItem: "option", processItem: async (ctx: any) => ctx.fill("Avis de {title} ; fiabilité : {reliability?}.").text },
    };
    const r = await run({
      entry: [{ title: "A", reliability: "bonne" }, { title: "B" }],
      blocks: [{ id: "b", type: "test.gabarit", params: { perItem: true, field: "notice" } }, { id: "sortie", type: "output" }],
      registry: registry,
    });
    expect(r.result!.data).toEqual([
      { title: "A", reliability: "bonne", notice: "Avis de A ; fiabilité : bonne." },
      { title: "B", notice: "Avis de B ; fiabilité : ." },
    ]);
    expect(r.blockEnd("b")).toMatchObject({ status: "succeeded" });
  });

  it("budgetSecondes: past the time, no more element launched, the following ones without champ, partial block", async () => {
    // Simulated clock: each element « lasts » 300 ms, the element's end advances the time.
    let now = 0;
    const launched: number[] = [];
    const r = await run({
      entry: list(12),
      clock: () => now,
      blocks: [{ id: "b", type: "test.lent", params: { field: "r", budgetSeconds: 1 } }, { id: "sortie", type: "output" }],
      registry: {
        "test.lent": {
          perItem: "always",
          async processItem(ctx: any) {
            launched.push(ctx.item.n);
            await Promise.resolve();
            now += 300;
            return "fait";
          },
        },
      },
    });
    // The two elements in progress finish before the next check: pairs launched at 0 and 600; at 1200, nothing more.
    expect(launched).toEqual([0, 1, 2, 3]);
    const output = r.result!.data as { n: number; r?: string }[];
    expect(output.filter((e) => e.r === "fait").map((e) => e.n)).toEqual([0, 1, 2, 3]);
    expect(output.slice(4).every((e) => !("r" in e))).toBe(true);
    expect(r.blockEnd("b")).toMatchObject({ status: "partial" });
    expect(r.log("b")).toContain("temps écoulé : 8 élément(s) non lancé(s)");
  });

  it("the global time (150 s since debut) also stops launching elements", async () => {
    let now = 0;
    let launched = 0;
    const r = await run({
      entry: list(10),
      clock: () => now,
      deadline: 250,
      blocks: [{ id: "b", type: "test.lent", params: { field: "r" } }, { id: "sortie", type: "output" }],
      registry: {
        "test.lent": {
          perItem: "always",
          async processItem() {
            launched++;
            await Promise.resolve();
            now += 100;
            return 1;
          },
        },
      },
    });
    // Pairs launched at 0 and 200; at 400, nothing more.
    expect(launched).toBe(4);
    expect(r.blockEnd("b")).toMatchObject({ status: "partial" });
  });

  it("among the launched elements, none succeeded and at least one failed: the block fails (not launched and absent values do not count)", async () => {
    let now = 0;
    const registry = {
      "test.ko": {
        perItem: "always",
        failIfAllFail: true,
        async processItem(ctx: any) {
          ctx.fill("{url}");
          await Promise.resolve();
          now += 600;
          throw new Error("raté");
        },
      },
    };
    const time = await run({
      entry: list(6).map((e) => ({ ...e, url: "u" })),
      clock: () => now,
      blocks: [{ id: "b", type: "test.ko", params: { field: "r", budgetSeconds: 1 } }, { id: "sortie", type: "output" }],
      registry: registry,
    });
    expect(time.blockEnd("b")).toMatchObject({ status: "failed" });
    expect(time.error?.message).toContain("raté");

    const absent = await run({
      entry: [{ url: "u" }, { other: 1 }],
      blocks: [{ id: "b", type: "test.ko", params: { field: "r" } }, { id: "sortie", type: "output" }],
      registry: registry,
    });
    expect(absent.blockEnd("b")).toMatchObject({ status: "failed" });
  });

  it("reuse reuses the memory's value without a call and stores the new ones", async () => {
    const computed: string[] = [];
    const r = await run({
      entry: [{ url: "https://a.fr/1" }, { url: "https://a.fr/2" }, { url: null }],
      memory: { b: { type: "test.resume", value: { reused: [["https://a.fr/1", "déjà fait"], ["https://vieux.fr/", "vieux"]] } } },
      blocks: [{ id: "b", type: "test.resume", params: { field: "resume", reuse: "url" } }, { id: "sortie", type: "output" }],
      registry: {
        "test.resume": {
          perItem: "always",
          async processItem(ctx: any) {
            computed.push(String(ctx.item.url));
            return `résumé de ${ctx.item.url}`;
          },
        },
      },
    });
    expect(computed).toEqual(["https://a.fr/2", "null"]);
    expect(r.result!.data).toEqual([
      { url: "https://a.fr/1", resume: "déjà fait" },
      { url: "https://a.fr/2", resume: "résumé de https://a.fr/2" },
      { url: null, resume: "résumé de null" },
    ]);
    // The reused or computed values are the most recent; an element without a key is not stored. The old
    // pairs without a date are dated now.
    const m = "2026-10-29T10:00:00.000Z";
    expect(r.result!.memory.b).toEqual({
      type: "test.resume",
      value: { reused: [["https://vieux.fr/", "vieux", m], ["https://a.fr/1", "déjà fait", m], ["https://a.fr/2", "résumé de https://a.fr/2", m]] },
    });
  });

  it("reuse keeps at most 2 MB per block, forgetting the oldest", async () => {
    const big = "x".repeat(600 * 1024);
    const r = await run({
      entry: list(5).map((e) => ({ ...e, key: `k${e.n}` })),
      blocks: [{ id: "b", type: "test.gros", params: { field: "g", reuse: "key" } }, { id: "sortie", type: "output" }],
      registry: { "test.gros": { perItem: "always", processItem: async () => big } },
    });
    const kept = (r.result!.memory.b!.value as { reused: [string, string][] }).reused.map(([k]) => k);
    expect(kept).toEqual(["k2", "k3", "k4"]);
  });

  it("all the memory sent fits in 2.5 MB: the oldest values of the biggest block go first", async () => {
    const big = "x".repeat(450 * 1024);
    const r = await run({
      entry: list(5).map((e) => ({ ...e, key: `k${e.n}` })),
      blocks: [
        { id: "b1", type: "test.gros", params: { field: "g1", reuse: "key" } },
        { id: "b2", type: "test.gros", params: { field: "g2", reuse: "key" } },
        { id: "sortie", type: "output" },
      ],
      registry: { "test.gros": { perItem: "always", processItem: async () => big } },
    });
    const memory = r.result!.memory;
    expect(Buffer.byteLength(JSON.stringify(memory))).toBeLessThanOrEqual(2.5 * 1024 * 1024);
    const keys = (id: string) => (memory[id]!.value as { reused: [string, string][] }).reused.map(([k]) => k);
    // Each bounded to 2 MB (4 kept), then the biggest loses its oldest, in turn.
    expect(keys("b1")).toEqual(["k3", "k4"]);
    expect(keys("b2")).toEqual(["k2", "k3", "k4"]);
  });

  it("finaliser receives the enriched list and returns the block's output", async () => {
    const r = await run({
      entry: list(4),
      blocks: [{ id: "b", type: "test.trier", params: { field: "p" } }, { id: "sortie", type: "output" }],
      registry: {
        "test.trier": {
          perItem: "always",
          processItem: async (ctx: any) => ctx.item.n / 4,
          finalize: async (l: { p: number }[]) => ({ output: l.filter((e) => e.p >= 0.5).sort((a, b) => b.p - a.p) }),
        },
      },
    });
    expect(r.result!.data).toEqual([{ n: 3, p: 0.75 }, { n: 2, p: 0.5 }]);
  });

  it("a simple block can end partial; a type without a module fails « type inconnu dans le conteneur »", async () => {
    const partial = await run({
      entry: 1,
      blocks: [{ id: "b", type: "test.p", params: {} }, { id: "sortie", type: "output" }],
      registry: {
        "test.p": {
          perItem: "no",
          run: async (ctx: any) => {
            ctx.partial("un flux en échec");
            return { output: 2 };
          },
        },
      },
    });
    expect(partial.blockEnd("b")).toMatchObject({ status: "partial", output: 2 });
    expect(partial.log("b")).toEqual(["un flux en échec"]);

    const unknown = await run({ entry: 1, blocks: [{ id: "b", type: "test.absent" }, { id: "sortie", type: "output" }], registry: {} });
    expect(unknown.error?.message).toBe("type inconnu dans le conteneur : test.absent");
  });
});

describe("interpreter: web.chercher", () => {
  const WEB = { web: true, maxDurationMinutes: null, owner: "widget" as const, input: false };
  const announcements = [
    { mark: "Peugeot", model: "208 & co/é" },
    { mark: "Renault", model: "Clio" },
    { mark: "Fiat", model: "Panda" },
  ];
  const workflow = (params: Record<string, unknown> = {}) => ({
    version: 1,
    blocks: [
      block("liste", "code", { source: "liste.mjs" }),
      block("cherche", "web.search", { query: "{mark} {model} fiabilité", perItem: true, ...params }),
      output,
    ],
    links: chain("liste", "cherche", "sortie"),
  });
  const files = { "liste.mjs": `export default async () => (${JSON.stringify(announcements)});` };
  const result = (request: string) => [{ title: "Avis " + request, url: "https://avis.fr/1", excerpt: "Bien", rank: 1 }];
  const logOf = (r: { lines: any[] }, id: string) => r.lines.filter((l) => l.t === "log" && l.block === id).map((l) => l.text);

  it("web.chercher per element stores the list under recherche, query filled with {marque} {modele} without encoding", async () => {
    const r = await launch({
      workflow: workflow({ count: 5 }),
      files: files,
      context: WEB,
      reply: (a) => (a.f === "searchWeb" ? { ok: result(a.a.query) } : { error: "inattendu" }),
    });
    expect(r.calls.map((a) => [a.f, a.a]).sort()).toEqual(
      [
        ["searchWeb", { query: "Peugeot 208 & co/é fiabilité", count: 5 }],
        ["searchWeb", { query: "Renault Clio fiabilité", count: 5 }],
        ["searchWeb", { query: "Fiat Panda fiabilité", count: 5 }],
      ].sort(),
    );
    // Remise en forme : titre, url, extrait en textes ; rien d'autre.
    expect(r.terminal).toEqual({
      t: "end",
      data: announcements.map((e) => ({ ...e, search: [{ title: `Avis ${e.mark} ${e.model} fiabilité`, url: "https://avis.fr/1", excerpt: "Bien" }] })),
    });
    expect(r.blockEnd("cherche")).toMatchObject({ status: "succeeded" });
  });

  it("ceiling reached: the remaining elements without champ, partial block, even with onError echouer", async () => {
    let n = 0;
    const r = await launch({
      workflow: workflow({ onError: "fail" }),
      files: files,
      context: WEB,
      reply: (a) => (++n === 1 ? { ok: result(a.a.query) } : { error: SEARCHES_CAP }),
    });
    expect(r.terminal.t).toBe("end");
    const data = r.terminal.data as Record<string, unknown>[];
    expect(data.filter((e) => "search" in e)).toHaveLength(1);
    expect(data.filter((e) => !("search" in e))).toHaveLength(2);
    expect(r.blockEnd("cherche")).toMatchObject({ status: "partial" });
    const log = logOf(r, "cherche");
    // One line for the first refusal, one for the elements that follow: not one per element.
    expect(log.filter((t) => /^élément \d : /.test(t))).toEqual([expect.stringContaining(` : ${SEARCHES_CAP}`)]);
    expect(log.length).toBeLessThanOrEqual(2);
    // The sortie block did run.
    expect(r.blockEnd("sortie")).toMatchObject({ status: "succeeded" });
  });

  it("after the kernel's first refusal, no more search: the remaining elements not launched, only one more line", async () => {
    const twenty = Array.from({ length: 20 }, (_, i) => ({ mark: "M" + i, model: "X" }));
    const r = await launch({
      workflow: workflow({ reuse: "mark" }),
      files: { "liste.mjs": `export default async () => (${JSON.stringify(twenty)});` },
      context: WEB,
      // M15 is already known: it is reused without a search, even after the refusal.
      memory: { cherche: { type: "web.search", value: { reused: [["M15", [{ title: "Connu", url: "https://avis.fr/15", excerpt: "" }]]] } } },
      reply: (a) => (a.a.query.startsWith("M0 ") ? { ok: result(a.a.query) } : { error: SEARCHES_STOPPED }),
    });
    expect(r.terminal.t).toBe("end");
    // M0 and M1 leave together (two at a time); M1 refused, M2 at most could leave before the refusal was known.
    expect(r.calls.length).toBeLessThanOrEqual(3);
    const data = r.terminal.data as Record<string, unknown>[];
    expect(data.filter((e) => "search" in e).map((e) => e.mark)).toEqual(["M0", "M15"]);
    expect(r.blockEnd("cherche")).toMatchObject({ status: "partial" });
    const log = logOf(r, "cherche");
    expect(log).toHaveLength(2);
    expect(log[0]).toMatch(new RegExp(`^élément \\d+ : ${SEARCHES_STOPPED.replace(/[()]/g, "\\$&")}$`));
    expect(log[1]).toBe("17 autre(s) élément(s) non lancé(s)");
  });

  it("in simple mode, success returns the list itself, reshaped (non-texts as \"\", extra keys removed)", async () => {
    const r = await launch({
      workflow: { version: 1, blocks: [block("cherche", "web.search", { query: "rust" }), output], links: chain("cherche", "sortie") },
      context: WEB,
      reply: () => ({ ok: [{ title: 1, url: "u", excerpt: null, rank: 2 }] }),
    });
    expect(r.terminal).toEqual({ t: "end", data: [{ title: "", url: "u", excerpt: "" }] });
    expect(r.blockEnd("cherche")).toMatchObject({ status: "succeeded" });
  });

  it("a response that is not a list: « résultats de recherche invalides »", async () => {
    const r = await launch({
      workflow: { version: 1, blocks: [block("cherche", "web.search", { query: "rust" }), output], links: chain("cherche", "sortie") },
      context: WEB,
      reply: () => ({ ok: {} }),
    });
    expect(r.blockEnd("cherche")).toMatchObject({ status: "failed", error: "résultats de recherche invalides" });
  });

  it("the filled query is cut to 500 characters and stripped of its blanks; empty, it is an absent value", async () => {
    const elements = [{ mark: "  " + "a".repeat(400), model: "b".repeat(400) }, { mark: "   ", model: "  " }];
    const r = await launch({
      workflow: workflow({ query: "{mark} {model}" }),
      files: { "liste.mjs": `export default async () => (${JSON.stringify(elements)});` },
      context: WEB,
      reply: (a) => ({ ok: result(a.a.query) }),
    });
    expect(r.calls.map((a) => a.a.query)).toEqual(["a".repeat(400) + " " + "b".repeat(99)]);
    const data = r.terminal.data as Record<string, unknown>[];
    expect("search" in data[0]!).toBe(true);
    expect("search" in data[1]!).toBe(false);
    expect(logOf(r, "cherche")).toEqual(["élément 2 : valeur absente : query"]);
  });

  it("SEARCH_DENIED on an element with onError echouer: the block fails", async () => {
    const r = await launch({
      workflow: workflow({ onError: "fail" }),
      files: files,
      context: WEB,
      reply: (a) => (a.a.query.startsWith("Renault") ? { error: SEARCH_DENIED } : { ok: result(a.a.query) }),
    });
    expect(r.blockEnd("cherche")).toMatchObject({ status: "failed", error: SEARCH_DENIED });
    expect(r.terminal).toEqual({ t: "failure", error: SEARCH_DENIED });
  });

  it("in simple mode, the ceiling is an ordinary error", async () => {
    const r = await launch({
      workflow: {
        version: 1,
        blocks: [block("cherche", "web.search", { query: "{config.subject} actualité" }), output],
        links: chain("cherche", "sortie"),
      },
      config: { subject: "Rust" },
      context: WEB,
      reply: () => ({ error: SEARCHES_CAP }),
    });
    expect(r.calls.map((a) => a.a)).toEqual([{ query: "Rust actualité", count: 8 }]);
    expect(r.blockEnd("cherche")).toMatchObject({ status: "failed", error: SEARCHES_CAP });
    expect(r.terminal).toEqual({ t: "failure", error: SEARCHES_CAP });
  });

  it("replay from the block after web.chercher: no chercherWeb call", async () => {
    const searches = announcements.map((e) => ({ ...e, search: [{ title: "T", url: "https://avis.fr/1", excerpt: "E" }] }));
    const r = await launch({
      workflow: {
        version: 1,
        blocks: [...workflow().blocks.slice(0, 2), block("garder", "list.keep", { count: 2 }), output],
        links: chain("liste", "cherche", "garder", "sortie"),
      },
      files: files,
      context: WEB,
      replay: { reruns: ["garder", "sortie"], outputs: { cherche: searches } },
      reply: () => ({ error: "aucun appel attendu" }),
    });
    expect(r.calls).toEqual([]);
    expect(r.terminal).toEqual({ t: "end", data: searches.slice(0, 2) });
  });
});

describe("interpreter: dated memory (keepDays)", () => {
  const NOW = "2026-10-29T10:00:00.000Z";
  const ago = (days: number) => new Date(Date.parse(NOW) - days * 86_400_000).toISOString();
  const fresh = (entry: unknown[], memory: unknown, params: Record<string, unknown> = {}) =>
    newList.run({ input: entry, params: { key: "url", ...params }, memory: memory, log: () => {}, now: NOW });

  it("a key seen 31 days ago with keepDays 30 becomes new again; at 29 days, not", async () => {
    const r = await fresh([{ url: "vieille" }, { url: "recente" }], [["vieille", ago(31)], ["recente", ago(29)], ["oubliee", ago(31)]], {
      keepDays: 30,
    });
    expect(r.output).toEqual([{ url: "vieille" }]);
    expect(r.newKeys).toEqual(["vieille"]);
    // The too-old, never-seen-again entry is not rewritten; the seen-again keys take today's date.
    expect(r.memory).toEqual([["vieille", NOW], ["recente", NOW]]);
  });

  it("without keepDays, a 400-day-old key stays seen", async () => {
    const r = await fresh([{ url: "a" }, { url: "b" }], [["a", ago(400)], ["autre", ago(400)]]);
    expect(r.output).toEqual([{ url: "b" }]);
    expect(r.newKeys).toEqual(["b"]);
    expect(r.memory).toEqual([["autre", ago(400)], ["a", NOW], ["b", NOW]]);
  });

  it("a seen-again key takes today's date", async () => {
    const r = await fresh([{ url: "a" }], [["a", ago(10)], ["b", ago(5)]], { keepDays: 30 });
    expect(r.output).toEqual([]);
    expect(r.newKeys).toEqual([]);
    expect(r.memory).toEqual([["b", ago(5)], ["a", NOW]]);
  });

  it("old memory in texts: read as seen, rewritten dated now", async () => {
    const r = await fresh([{ url: "a" }, { url: "c" }], ["a", "b"], { keepDays: 1 });
    expect(r.output).toEqual([{ url: "c" }]);
    expect(r.memory).toEqual([["b", NOW], ["a", NOW], ["c", NOW]]);
  });

  it("in the container, list.new receives now from the start line and returns a dated memory", async () => {
    const r = await launch({
      workflow: {
        version: 1,
        blocks: [block("src", "code", { source: "src.mjs" }), block("nv", "list.new", { key: "url", keepDays: 30 }), output],
        links: chain("src", "nv", "sortie"),
      },
      memory: { nv: { type: "list.new", value: [["a", ago(31)], ["b", ago(2)]] } },
      files: { "src.mjs": `export default async () => [{ url: "a" }, { url: "b" }];` },
    });
    expect(r.terminal.data).toEqual([{ url: "a" }]);
    expect(r.lines.find((l) => l.t === "memory").memory.nv.value).toEqual([["a", NOW], ["b", NOW]]);
  });

  const resume = (computed: string[]) => ({
    "test.resume": {
      perItem: "always",
      async processItem(ctx: any) {
        computed.push(String(ctx.item.url));
        return `résumé de ${ctx.item.url}`;
      },
    },
  });

  it("reuse with keepDays 30: 31-day value recomputed, 29-day one reused without a call and its date kept", async () => {
    const computed: string[] = [];
    const r = await run({
      entry: [{ url: "vieille" }, { url: "recente" }],
      memory: {
        b: { type: "test.resume", value: { reused: [["vieille", "ancien", ago(31)], ["recente", "gardé", ago(29)], ["oubliee", "x", ago(40)]] } },
      },
      blocks: [{ id: "b", type: "test.resume", params: { field: "resume", reuse: "url", keepDays: 30 } }, { id: "sortie", type: "output" }],
      registry: resume(computed),
    });
    expect(computed).toEqual(["vieille"]);
    expect(r.result!.data).toEqual([
      { url: "vieille", resume: "résumé de vieille" },
      { url: "recente", resume: "gardé" },
    ]);
    // The too-old entry never seen again is forgotten; the reuse does not refresh the date.
    expect([...(r.result!.memory.b!.value as { reused: unknown[] }).reused].sort()).toEqual([
      ["recente", "gardé", ago(29)],
      ["vieille", "résumé de vieille", NOW],
    ]);
  });

  it("without keepDays, reuse reuses a 400-day value", async () => {
    const computed: string[] = [];
    const r = await run({
      entry: [{ url: "a" }],
      memory: { b: { type: "test.resume", value: { reused: [["a", "très ancien", ago(400)]] } } },
      blocks: [{ id: "b", type: "test.resume", params: { field: "resume", reuse: "url" } }, { id: "sortie", type: "output" }],
      registry: resume(computed),
    });
    expect(computed).toEqual([]);
    expect(r.result!.memory.b!.value).toEqual({ reused: [["a", "très ancien", ago(400)]] });
  });

  it("old [cle, valeur] pairs of reuse reused without a call", async () => {
    const computed: string[] = [];
    const r = await run({
      entry: [{ url: "a" }],
      memory: { b: { type: "test.resume", value: { reused: [["a", "ancien"], ["b", "autre"]] } } },
      blocks: [{ id: "b", type: "test.resume", params: { field: "resume", reuse: "url", keepDays: 1 } }, { id: "sortie", type: "output" }],
      registry: resume(computed),
    });
    expect(computed).toEqual([]);
    expect(r.result!.data).toEqual([{ url: "a", resume: "ancien" }]);
    expect(r.result!.memory.b!.value).toEqual({ reused: [["b", "autre", NOW], ["a", "ancien", NOW]] });
  });

  it("reuse: two elements with the same key processed at the same time make only one call", async () => {
    let calls = 0;
    const r = await run({
      entry: [{ model: "Clio", n: 1 }, { model: "Clio", n: 2 }, { model: "208", n: 3 }],
      blocks: [{ id: "b", type: "test.avis", params: { field: "notice", reuse: "model" } }, { id: "sortie", type: "output" }],
      registry: {
        "test.avis": {
          perItem: "always",
          async processItem(ctx: any) {
            calls++;
            await wait(20);
            return `avis ${ctx.item.model}`;
          },
        },
      },
    });
    expect(calls).toBe(2);
    expect(r.result!.data).toEqual([
      { model: "Clio", n: 1, notice: "avis Clio" },
      { model: "Clio", n: 2, notice: "avis Clio" },
      { model: "208", n: 3, notice: "avis 208" },
    ]);
    expect(r.blockEnd("b")).toMatchObject({ status: "succeeded" });
  });

  it("reuse: if the in-progress computation of the same key fails, the second element computes itself", async () => {
    const launched: number[] = [];
    const r = await run({
      entry: [{ model: "Clio", n: 1 }, { model: "Clio", n: 2 }],
      blocks: [{ id: "b", type: "test.avis", params: { field: "notice", reuse: "model" } }, { id: "sortie", type: "output" }],
      registry: {
        "test.avis": {
          perItem: "always",
          async processItem(ctx: any) {
            launched.push(ctx.item.n);
            await wait(10);
            if (ctx.item.n === 1) throw new Error("raté");
            return "avis";
          },
        },
      },
    });
    expect(launched).toEqual([1, 2]);
    expect(r.result!.data).toEqual([{ model: "Clio", n: 1 }, { model: "Clio", n: 2, notice: "avis" }]);
    expect(r.blockEnd("b")).toMatchObject({ status: "partial" });
  });
});

describe("interpreter: progressive run", () => {
  const NOW = "2026-10-29T10:00:00.000Z";
  const OLD = "2026-10-01T10:00:00.000Z";
  const memories = (r: { traces: any[] }) => r.traces.filter((l) => l.t === "memory").map((l) => l.memory);
  const notice = (failedOn: string) => ({
    perItem: "always",
    async processItem(ctx: any) {
      await Promise.resolve();
      if (ctx.item.model === failedOn) throw new Error("raté");
      return `avis ${ctx.item.model}`;
    },
  });
  const noticeFailure = (progressive: boolean) =>
    run({
      progressive: progressive,
      entry: [{ url: "a", model: "Clio" }, { url: "b", model: "208" }, { url: "c", model: "Panda" }],
      memory: { nv: { type: "list.new", value: [["vieille", OLD]] } },
      blocks: [
        { id: "nv", type: "list.new", params: { key: "url" } },
        { id: "avis", type: "test.avis", params: { field: "notice", reuse: "model", onError: "fail" } },
        { id: "sortie", type: "output" },
      ],
      registry: { "list.new": newList, "test.avis": notice("Panda") },
    });

  // nouvelles → tri → garder 2 → lire (one failing read) → sortie
  const watch = (progressive: boolean) =>
    run({
      progressive: progressive,
      entry: ["a", "b", "c", "d", "e", "f"].map((url) => ({ url, note: url === "b" ? 1 : 9 })),
      memory: { nv: { type: "list.new", value: [["a", OLD]] } },
      blocks: [
        { id: "nv", type: "list.new", params: { key: "url" } },
        { id: "tri", type: "test.tri", params: { field: "n" } },
        { id: "garder", type: "list.keep", params: { count: 2 } },
        { id: "lire", type: "test.lire", params: { field: "page" } },
        { id: "sortie", type: "output" },
      ],
      registry: {
        "list.new": newList,
        "list.keep": keepList,
        "test.tri": {
          perItem: "always",
          async processItem(ctx: any) {
            return ctx.item.note;
          },
          async finalize(list: any[]) {
            return { output: list.filter((e) => e.n >= 5) };
          },
        },
        "test.lire": {
          perItem: "always",
          async processItem(ctx: any) {
            if (ctx.item.url === "d") throw new Error("page illisible");
            return "texte";
          },
        },
      },
    });

  it("progressive: a block error sends the memory (reliabilities already found) before echec", async () => {
    const r = await noticeFailure(true);
    expect(r.error?.message).toBe("raté");
    expect(memories(r)).toEqual([
      {
        // a, b, c finished no block sequence: not retained, they will come back.
        nv: { type: "list.new", value: [["vieille", OLD]] },
        avis: { type: "test.avis", value: { reused: [["Clio", "avis Clio", NOW], ["208", "avis 208", NOW]] } },
      },
    ]);
    // Sent after the block's failed end, just before rethrowing the error (so before echec).
    expect(r.traces.at(-1)?.t).toBe("memory");
    expect(r.traces.at(-2)).toMatchObject({ t: "block", id: "avis", step: "end", status: "failed" });
  });

  it("progressive: memory sent at most every 30 s (fake clock), and the last one before fin", async () => {
    let now = 0;
    const r = await run({
      progressive: true,
      entry: list(10).map((e) => ({ ...e, url: `u${e.n}` })),
      clock: () => now,
      blocks: [{ id: "lent", type: "test.lent", params: { field: "r", reuse: "url" } }, { id: "sortie", type: "output" }],
      registry: {
        "test.lent": {
          perItem: "always",
          async processItem(ctx: any) {
            await Promise.resolve();
            now += 10_000;
            return `fait ${ctx.item.n}`;
          },
        },
      },
    });
    expect(r.error).toBeNull();
    // Ten 10 s elements, two at a time: the pairs finish at 20, 40, 60, 80, 100 s. Checked at the end of each
    // element and each block, the memory leaves at 40 s (4 opinions) and 80 s (8 opinions) only: not at 20, 60 or 100.
    expect(memories(r).map((m) => m.lent.value.reused.length)).toEqual([4, 8]);
    expect((r.result!.memory.lent!.value as { reused: unknown[] }).reused).toHaveLength(10);

    // In the container: the last memory just before fin, as today.
    const c = await launch({
      workflow: { version: 1, blocks: [block("src", "code", { source: "src.mjs" }), output], links: chain("src", "sortie") },
      files: { "src.mjs": `export default async () => [1];` },
      start: { progressive: true },
    });
    expect(c.traces.slice(-2).map((l) => l.t)).toEqual(["memory", "end"]);
  });

  it("progressive: nouvelles → tri → garder 2 → lire (one failing read) → sortie: the failing listing's key is not retained, those dropped by garder and by the sort are, the two read ones too", async () => {
    const r = await watch(true);
    expect(r.error).toBeNull();
    expect(r.result!.data).toEqual([{ url: "c", note: 9, n: 9, page: "texte" }, { url: "d", note: 9, n: 9 }]);
    // b dropped by the sort, e and f by garder, c read and output; d failed; a seen again takes today's date.
    expect(r.result!.memory.nv!.value).toEqual([["a", NOW], ["b", NOW], ["c", NOW], ["e", NOW], ["f", NOW]]);
  });

  it("progressive: element not launched for lack of time: its key is not retained", async () => {
    let now = 0;
    const r = await run({
      progressive: true,
      entry: list(12).map((e) => ({ ...e, url: `u${e.n}` })),
      clock: () => now,
      blocks: [
        { id: "nv", type: "list.new", params: { key: "url" } },
        { id: "lent", type: "test.lent", params: { field: "r", budgetSeconds: 1 } },
        { id: "sortie", type: "output" },
      ],
      registry: {
        "list.new": newList,
        "test.lent": {
          perItem: "always",
          async processItem() {
            await Promise.resolve();
            now += 300;
            return "fait";
          },
        },
      },
    });
    expect(r.blockEnd("lent")).toMatchObject({ status: "partial" });
    expect(r.result!.memory.nv!.value).toEqual(["u0", "u1", "u2", "u3"].map((c) => [c, NOW]));
  });

  it("progressive: element refused by the kernel (ElementNonLance): its key is not retained", async () => {
    const r = await run({
      progressive: true,
      entry: list(3).map((e) => ({ ...e, url: `u${e.n}` })),
      blocks: [
        { id: "nv", type: "list.new", params: { key: "url" } },
        { id: "cherche", type: "test.cherche", params: { field: "r" } },
        { id: "sortie", type: "output" },
      ],
      registry: {
        "list.new": newList,
        "test.cherche": {
          perItem: "always",
          async processItem(ctx: any) {
            if (ctx.item.n === 2) throw new NotRunElement(SEARCHES_CAP);
            return "ok";
          },
        },
      },
    });
    expect(r.result!.memory.nv!.value).toEqual([["u0", NOW], ["u1", NOW]]);
  });

  it("without progressive: all the new keys retained and no memory before echec (as before)", async () => {
    const r = await watch(false);
    expect(r.result!.memory.nv!.value).toEqual(["a", "b", "c", "d", "e", "f"].map((c) => [c, NOW]));
    expect(memories(r)).toEqual([]);

    const ko = await noticeFailure(false);
    expect(ko.error?.message).toBe("raté");
    expect(memories(ko)).toEqual([]);
  });

  const readExceptOn = (failedOn: string, field = "url") => ({
    perItem: "always",
    async processItem(ctx: any) {
      if (ctx.item[field] === failedOn) throw new Error("page illisible");
      return "texte";
    },
  });
  const abc = () => ["a", "b", "c"].map((url) => ({ url }));

  it("progressive: code that renames the key field then a failing element: nothing resolved afterwards, b comes back, one log line", async () => {
    const r = await run({
      progressive: true,
      entry: abc(),
      blocks: [
        { id: "nv", type: "list.new", params: { key: "url" } },
        { id: "remodeler", type: "test.code" },
        { id: "lire", type: "test.lire", params: { field: "page" } },
        { id: "sortie", type: "output" },
      ],
      registry: {
        "list.new": newList,
        "test.code": { perItem: "no", run: async (ctx: any) => ({ output: ctx.input.map((e: any) => ({ link: e.url })) }) },
        "test.lire": readExceptOn("b", "link"),
      },
    });
    expect(r.error).toBeNull();
    expect(r.result!.memory.nv!.value).toEqual([]);
    expect(r.log("nv")).toContain(
      "le champ url n'est plus dans les éléments : un élément en échec n'a pas pu être reconnu, les éléments pas encore résolus reviendront la fois suivante",
    );
  });

  it("progressive: code that renames the key field without a failure afterwards: all retained after the output", async () => {
    const r = await run({
      progressive: true,
      entry: abc(),
      blocks: [
        { id: "nv", type: "list.new", params: { key: "url" } },
        { id: "remodeler", type: "test.code" },
        { id: "sortie", type: "output" },
      ],
      registry: {
        "list.new": newList,
        "test.code": { perItem: "no", run: async (ctx: any) => ({ output: ctx.input.map((e: any) => ({ link: e.url })) }) },
      },
    });
    expect(r.result!.memory.nv!.value).toEqual(["a", "b", "c"].map((c) => [c, NOW]));
    expect(r.log("nv")).toEqual([]);
  });

  it("progressive: code that filters drops b (resolved), c failing further on is not retained", async () => {
    const r = await run({
      progressive: true,
      entry: abc(),
      blocks: [
        { id: "nv", type: "list.new", params: { key: "url" } },
        { id: "filtrer", type: "test.code" },
        { id: "lire", type: "test.lire", params: { field: "page" } },
        { id: "sortie", type: "output" },
      ],
      registry: {
        "list.new": newList,
        "test.code": { perItem: "no", run: async (ctx: any) => ({ output: ctx.input.filter((e: any) => e.url !== "b") }) },
        "test.lire": readExceptOn("c"),
      },
    });
    expect(r.result!.data).toEqual([{ url: "a", page: "texte" }, { url: "c" }]);
    expect(r.result!.memory.nv!.value).toEqual([["a", NOW], ["b", NOW]]);
  });

  it("progressive: parallel branches, b dropped by garder on one and failing on the other, is not retained (in both orders)", async () => {
    for (const order of [["src", "nv", "garder", "lire", "sortie"], ["src", "nv", "lire", "garder", "sortie"]]) {
      const traces: any[] = [];
      const r = await runWorkflow({
        workflow: {
          blocks: [
            { id: "src", type: "test.source", params: {} },
            { id: "nv", type: "list.new", params: { key: "url" } },
            { id: "garder", type: "list.keep", params: { count: 1 } },
            { id: "lire", type: "test.lire", params: { field: "page" } },
            { id: "sortie", type: "output", params: {} },
          ],
          links: [
            { from: "src", to: "nv" },
            { from: "nv", to: "garder" },
            { from: "nv", to: "lire" },
            { from: "garder", to: "sortie" },
            { from: "lire", to: "sortie" },
          ],
          order: order,
        },
        memory: {},
        now: NOW,
        folder: "/nulle-part",
        call: async () => null,
        trace: (m: unknown) => traces.push(m),
        progressive: true,
        blocks: {
          "test.source": { perItem: "no", run: async () => ({ output: abc() }) },
          "list.new": newList,
          "list.keep": keepList,
          "test.lire": readExceptOn("b"),
          output: { perItem: "no", run: async (ctx: any) => ({ output: ctx.input }) },
        },
      });
      expect(r.memory.nv.value, order.join(",")).toEqual([["a", NOW], ["c", NOW]]);
    }
  });

  it("progressive: pending keys are removed before the 5000-key ceiling", async () => {
    const olds = Array.from({ length: 5000 }, (_, i) => [`k${i}`, OLD]);
    const r = await run({
      progressive: true,
      entry: [{ url: "x" }],
      memory: { nv: { type: "list.new", value: olds } },
      blocks: [
        { id: "nv", type: "list.new", params: { key: "url" } },
        { id: "lire", type: "test.lire", params: { field: "page" } },
        { id: "sortie", type: "output" },
      ],
      registry: { "list.new": newList, "test.lire": readExceptOn("x") },
    });
    // x failing is not retained and does not make k0 forgotten.
    expect(r.result!.memory.nv!.value).toEqual(olds);
  });

  it("a progressive trial (replay) sends no memory", async () => {
    let now = 0;
    const r = await run({
      progressive: true,
      entry: null,
      clock: () => now,
      blocks: [
        { id: "avis", type: "test.avis", params: { field: "notice", onError: "fail" } },
        { id: "sortie", type: "output" },
      ],
      registry: {
        "test.avis": {
          perItem: "always",
          async processItem(ctx: any) {
            now += 20_000;
            if (ctx.item.model === "Panda") throw new Error("raté");
            return "avis";
          },
        },
      },
      replay: { reruns: ["avis", "sortie"], outputs: { src: [{ model: "Clio" }, { model: "208" }, { model: "Panda" }] } },
    });
    expect(r.error?.message).toBe("raté");
    expect(memories(r)).toEqual([]);
  });

  it("reuse: if the in-progress computation of the same key is refused by the kernel, the second element does not relaunch it", async () => {
    const launched: number[] = [];
    const r = await run({
      entry: [{ model: "Clio", n: 1 }, { model: "Clio", n: 2 }],
      blocks: [{ id: "b", type: "test.avis", params: { field: "notice", reuse: "model" } }, { id: "sortie", type: "output" }],
      registry: {
        "test.avis": {
          perItem: "always",
          async processItem(ctx: any) {
            launched.push(ctx.item.n);
            await wait(10);
            throw new NotRunElement(SEARCHES_CAP);
          },
        },
      },
    });
    expect(launched).toEqual([1]);
    expect(r.blockEnd("b")).toMatchObject({ status: "partial" });
  });
});

describe("interpreter: streaming chain", () => {
  type AppEvent = string;
  /** A chainable test block: notes `start:<block>:<n>` and `end:<block>:<n>` and returns `<block> <n>`. */
  const step = (name: string, events: AppEvent[], o: { duration?: (n: number) => number; clock?: { t: number }; failsOn?: number; turns?: (n: number) => number } = {}) => ({
    perItem: "option",
    async run(ctx: any) {
      events.push(`bloc:${name}`);
      return { output: ctx.input.map((e: any) => ({ ...e, [ctx.params.field]: `${name} ${e.n}` })) };
    },
    async processItem(ctx: any) {
      const n = ctx.item.n;
      events.push(`start:${name}:${n}`);
      // A « slow » element waits more micro-task queue turns: it finishes after others launched after it.
      for (let k = 0; k < (o.turns?.(n) ?? 1); k++) await Promise.resolve();
      if (o.clock && o.duration) o.clock.t += o.duration(n);
      events.push(`end:${name}:${n}`);
      if (n === o.failsOn) throw new Error(`${name} raté`);
      return `${name} ${n}`;
    },
  });
  const CHAIN_BLOCKS = (outputParams: Record<string, unknown> = { live: true }, extra: Record<string, Record<string, unknown>> = {}) => [
    { id: "fiche", type: "test.fiche", params: { perItem: true, field: "page", ...extra.fiche } },
    { id: "fiabilite", type: "test.fiabilite", params: { perItem: true, field: "reliability", ...extra.fiabilite } },
    { id: "avis", type: "test.avis", params: { perItem: true, field: "notice", ...extra.avis } },
    { id: "sortie", type: "output", params: outputParams },
  ];
  const chainRegistry = (events: AppEvent[], o: Parameters<typeof step>[2] = {}, byBlock: Record<string, Parameters<typeof step>[2]> = {}) => ({
    "test.fiche": step("fiche", events, { ...o, ...byBlock.fiche }),
    "test.fiabilite": step("fiabilite", events, { ...o, ...byBlock.fiabilite }),
    "test.avis": step("avis", events, { ...o, ...byBlock.avis }),
  });
  const publications = (r: { traces: any[] }) => r.traces.filter((l) => l.t === "publication");
  const resume = (r: { traces: any[] }) =>
    r.traces.filter((l) => l.t === "block").map((l) => `${l.step}:${l.id}`);

  it("streaming: each listing goes through fiche → fiabilite → avis before being finished, two at a time", async () => {
    const events: AppEvent[] = [];
    const r = await run({
      progressive: true,
      entry: list(6),
      blocks: CHAIN_BLOCKS(),
      registry: chainRegistry(events),
    });
    expect(r.error).toBeNull();
    // Each listing passes the three blocks in order.
    for (let n = 0; n < 6; n++) {
      const pos = (e: string) => events.indexOf(e);
      expect(pos(`end:fiche:${n}`)).toBeLessThan(pos(`start:fiabilite:${n}`));
      expect(pos(`end:fiabilite:${n}`)).toBeLessThan(pos(`start:avis:${n}`));
    }
    // Two listings at a time at most: a listing is in progress from the start of its fiche to the end of its avis.
    let running = 0;
    let max = 0;
    for (const e of events) {
      if (e.startsWith("start:fiche:")) max = Math.max(max, ++running);
      if (e.startsWith("end:avis:")) running--;
    }
    expect(max).toBe(2);
    // The third only starts after one of the first two has finished its avis.
    expect(Math.min(events.indexOf("end:avis:0"), events.indexOf("end:avis:1"))).toBeLessThan(events.indexOf("start:fiche:2"));
    expect(r.result!.data).toEqual(list(6).map((e) => ({ ...e, page: `fiche ${e.n}`, reliability: `fiabilite ${e.n}`, notice: `avis ${e.n}` })));
  });

  it("publications: elements finished in list order, at most one every 5 s, done and total correct", async () => {
    const events: AppEvent[] = [];
    const clock = { t: 0 };
    const traces: any[] = [];
    // Listing 0 is slow (9 s fiche, and more turns): listing 1 finishes before it. The other blocks take 1 s.
    const r = await run({
      progressive: true,
      entry: list(10),
      clock: () => clock.t,
      blocks: CHAIN_BLOCKS(),
      registry: chainRegistry(events, { clock: clock, duration: () => 1000 }, { fiche: { clock: clock, duration: (n) => (n === 0 ? 9000 : 1000), turns: (n) => (n === 0 ? 50 : 1) } }),
    });
    expect(r.error).toBeNull();
    traces.push(...r.traces);
    const pubs = publications(r);
    const final = list(10).map((e) => ({ ...e, page: `fiche ${e.n}`, reliability: `fiabilite ${e.n}`, notice: `avis ${e.n}` }));
    expect(pubs.length).toBeGreaterThan(1);
    expect(pubs.length).toBeLessThan(10);
    // The first as soon as the first listing is finished: listing 1, before 0.
    expect(pubs[0]).toEqual({ t: "publication", data: [final[1]], done: 1, total: 10 });
    // Once listing 0 is finished, it comes first: the order is the list's, not the finishes'.
    expect(pubs.at(-1).data[0]).toEqual(final[0]);
    let doneBefore = 0;
    for (const p of pubs) {
      expect(p.total).toBe(10);
      expect(p.done).toBe(p.data.length);
      expect(p.done).toBeGreaterThan(doneBefore);
      doneBefore = p.done;
      // In list order, as after the last block.
      const ns = p.data.map((e: any) => e.n);
      expect(ns).toEqual([...ns].sort((a: number, b: number) => a - b));
      for (const e of p.data) expect(e).toEqual(final[e.n]);
    }
    // Each publication right after a memoire line; 5 s at least between two publications (time of the memory
    // sent just before, seen by the trace stream).
    const indices = traces.map((l, i) => (l.t === "publication" ? i : -1)).filter((i) => i >= 0);
    for (const i of indices) expect(traces[i - 1].t).toBe("memory");
    expect(r.result!.data).toEqual(final);
  });

  it("publications: never two within 5 s (fake clock time at each publication)", async () => {
    const clock = { t: 0 };
    const hours: number[] = [];
    const events: AppEvent[] = [];
    const registry = chainRegistry(events, { clock: clock, duration: () => 700 });
    const traces: any[] = [];
    const workflow = {
      blocks: [{ id: "src", type: "test.source", params: {} }, ...CHAIN_BLOCKS()],
      links: chain("src", "fiche", "fiabilite", "avis", "sortie"),
      order: ["src", "fiche", "fiabilite", "avis", "sortie"],
    };
    await runWorkflow({
      workflow,
      memory: {},
      now: "2026-10-29T10:00:00.000Z",
      folder: "/nulle-part",
      call: async () => null,
      trace: (m: any) => {
        traces.push(m);
        if (m.t === "publication") hours.push(clock.t);
      },
      blocks: {
        "test.source": { perItem: "no", run: async () => ({ output: list(20) }) },
        output: { perItem: "no", run: async (ctx: any) => ({ output: ctx.input }) },
        ...registry,
      },
      clock: () => clock.t,
      progressive: true,
    });
    expect(hours[0]).toBeLessThan(5000);
    for (let i = 1; i < hours.length; i++) expect(hours[i]! - hours[i - 1]!).toBeGreaterThanOrEqual(5000);
    // 20 listings of 2.1 s two at a time (~21 s): several publications, not one per listing.
    expect(hours.length).toBeGreaterThanOrEqual(3);
    expect(hours.length).toBeLessThanOrEqual(6);
  });

  it("traces: debut of the three blocks then their ends in order; each block's output = the list after it", async () => {
    const r = await run({ progressive: true, entry: list(3), blocks: CHAIN_BLOCKS(), registry: chainRegistry([]) });
    expect(resume(r)).toEqual([
      "start:src", "end:src",
      "start:fiche", "start:fiabilite", "start:avis",
      "end:fiche", "end:fiabilite", "end:avis",
      "start:sortie", "end:sortie",
    ]);
    expect(r.blockEnd("fiche")).toEqual({ t: "block", id: "fiche", step: "end", status: "succeeded", output: list(3).map((e) => ({ ...e, page: `fiche ${e.n}` })) });
    expect(r.blockEnd("fiabilite").output).toEqual(list(3).map((e) => ({ ...e, page: `fiche ${e.n}`, reliability: `fiabilite ${e.n}` })));
    expect(r.blockEnd("avis")).toMatchObject({ status: "succeeded", output: r.result!.data });
    expect(r.blockEnd("sortie").output).toEqual(list(3).map((e) => ({ ...e, page: `fiche ${e.n}`, reliability: `fiabilite ${e.n}`, notice: `avis ${e.n}` })));
  });

  it("fiche's budgetSecondes counted from the start of the chain: the following listings pass without a page, partial", async () => {
    const events: AppEvent[] = [];
    const clock = { t: 0 };
    // fiche takes no time, fiabilite 600 ms: past 1 s since the start of the chain, no more fiche.
    const r = await run({
      progressive: true,
      entry: list(5),
      clock: () => clock.t,
      blocks: CHAIN_BLOCKS({ live: true }, { fiche: { budgetSeconds: 1 } }),
      registry: chainRegistry(events, {}, { fiabilite: { clock: clock, duration: () => 600 } }),
    });
    expect(r.error).toBeNull();
    expect(events.filter((e) => e.startsWith("start:fiche:"))).toEqual(["start:fiche:0", "start:fiche:1"]);
    expect(events.filter((e) => e.startsWith("start:avis:"))).toHaveLength(5);
    expect(r.blockEnd("fiche")).toMatchObject({ status: "partial" });
    expect(r.log("fiche")).toContain("temps écoulé : 3 élément(s) non lancé(s)");
    expect(r.blockEnd("fiabilite")).toMatchObject({ status: "succeeded" });
    expect(r.blockEnd("avis")).toMatchObject({ status: "succeeded" });
    expect(r.result!.data).toEqual(
      list(5).map((e) => (e.n < 2 ? { ...e, page: `fiche ${e.n}` } : { ...e }) ).map((e) => ({ ...e, reliability: `fiabilite ${e.n}`, notice: `avis ${e.n}` })),
    );
  });

  it("without streaming: calls and traces block by block, identical to today", async () => {
    const events: AppEvent[] = [];
    const r = await run({ progressive: true, entry: list(3), blocks: CHAIN_BLOCKS({}), registry: chainRegistry(events) });
    expect(r.error).toBeNull();
    const starts = events.filter((e) => e.startsWith("start:"));
    expect(starts.slice(0, 3).every((e) => e.startsWith("start:fiche:"))).toBe(true);
    expect(starts.slice(3, 6).every((e) => e.startsWith("start:fiabilite:"))).toBe(true);
    expect(starts.slice(6).every((e) => e.startsWith("start:avis:"))).toBe(true);
    expect(resume(r)).toEqual([
      "start:src", "end:src", "start:fiche", "end:fiche", "start:fiabilite", "end:fiabilite", "start:avis", "end:avis", "start:sortie", "end:sortie",
    ]);
    expect(publications(r)).toEqual([]);
  });

  it("without progressive (a run that is not progressive): block by block, no publication", async () => {
    const events: AppEvent[] = [];
    const r = await run({ entry: list(3), blocks: CHAIN_BLOCKS(), registry: chainRegistry(events) });
    expect(resume(r)).toEqual([
      "start:src", "end:src", "start:fiche", "end:fiche", "start:fiabilite", "end:fiabilite", "start:avis", "end:avis", "start:sortie", "end:sortie",
    ]);
    expect(publications(r)).toEqual([]);
  });

  it("trial (replay) of an streaming workflow: block by block, no publication", async () => {
    const events: AppEvent[] = [];
    const r = await run({
      progressive: true,
      entry: list(3),
      blocks: CHAIN_BLOCKS(),
      registry: chainRegistry(events),
      replay: { reruns: ["src", "fiche", "fiabilite", "avis", "sortie"], outputs: {} },
    });
    expect(r.error).toBeNull();
    expect(resume(r)).toEqual([
      "start:src", "end:src", "start:fiche", "end:fiche", "start:fiabilite", "end:fiabilite", "start:avis", "end:avis", "start:sortie", "end:sortie",
    ]);
    expect(events.indexOf("end:fiche:2")).toBeLessThan(events.indexOf("start:fiabilite:0"));
    expect(publications(r)).toEqual([]);
  });

  it("streaming behind liste.garder: no publication, output at the end", async () => {
    const events: AppEvent[] = [];
    const [sheet, reliability, notice, s] = CHAIN_BLOCKS();
    const r = await run({
      progressive: true,
      entry: list(4),
      blocks: [sheet!, reliability!, notice!, { id: "garder", type: "list.keep", params: { count: 2 } }, s!],
      registry: { ...chainRegistry(events), "list.keep": keepList },
    });
    expect(r.error).toBeNull();
    expect(publications(r)).toEqual([]);
    expect(resume(r)).toEqual([
      "start:src", "end:src", "start:fiche", "end:fiche", "start:fiabilite", "end:fiabilite", "start:avis", "end:avis",
      "start:garder", "end:garder", "start:sortie", "end:sortie",
    ]);
    expect(r.result!.data).toHaveLength(2);
  });

  it("a failing element in the chain (sauter) is finished without the field, it is published; the block ends partial", async () => {
    const r = await run({
      progressive: true,
      entry: list(3),
      blocks: CHAIN_BLOCKS(),
      registry: chainRegistry([], {}, { fiabilite: { failsOn: 1 } }),
    });
    expect(r.error).toBeNull();
    expect(r.blockEnd("fiabilite")).toMatchObject({ status: "partial" });
    expect(r.blockEnd("fiche")).toMatchObject({ status: "succeeded" });
    expect(r.log("fiabilite").join("\n")).toContain("élément 2 : fiabilite raté");
    expect(r.result!.data).toEqual([
      { n: 0, page: "fiche 0", reliability: "fiabilite 0", notice: "avis 0" },
      { n: 1, page: "fiche 1", notice: "avis 1" },
      { n: 2, page: "fiche 2", reliability: "fiabilite 2", notice: "avis 2" },
    ]);
  });

  it("onError echouer in the chain: the block concerned fails, the others of the chain end partial, then memory and error", async () => {
    const r = await run({
      progressive: true,
      entry: list(4),
      blocks: CHAIN_BLOCKS({ live: true }, { fiabilite: { onError: "fail" } }),
      registry: chainRegistry([], {}, { fiabilite: { failsOn: 1 } }),
    });
    expect(r.error?.message).toBe("fiabilite raté");
    const ends = r.traces.filter((l) => l.t === "block" && l.step === "end" && l.id !== "src");
    expect(ends.map((l) => [l.id, l.status])).toEqual([["fiche", "partial"], ["fiabilite", "failed"], ["avis", "partial"]]);
    expect(r.blockEnd("fiabilite").error).toBe("fiabilite raté");
    expect(r.traces.some((l) => l.id === "sortie")).toBe(false);
    expect(r.traces.at(-1)?.t).toBe("memory");
  });

  it("keys: a listing that reached the end of the chain is retained in the memory sent before its publication; a failing listing is not", async () => {
    const r = await run({
      progressive: true,
      entry: list(3).map((e) => ({ ...e, url: `u${e.n}` })),
      blocks: [{ id: "nv", type: "list.new", params: { key: "url" } }, ...CHAIN_BLOCKS()],
      registry: { "list.new": newList, ...chainRegistry([], {}, { avis: { failsOn: 1 } }) },
    });
    expect(r.error).toBeNull();
    const pubs = r.traces.map((l, i) => [l, i] as const).filter(([l]) => l.t === "publication");
    // The first publication (u0 alone) follows a memory that already retains u0.
    const [first, i] = pubs[0]!;
    expect(first.data.map((e: any) => e.url)).toEqual(["u0"]);
    expect(r.traces[i - 1].memory.nv.value.map((e: any) => e[0])).toEqual(["u0"]);
    // At the end: u0 and u2 retained, u1 (failing opinion) will come back.
    expect((r.result!.memory.nv!.value as [string, string][]).map((e) => e[0])).toEqual(["u0", "u2"]);
  });

  it("keys: an element finished less than 5 s after a publication, then an echouer: its key is not in the last memory", async () => {
    const events: AppEvent[] = [];
    const r = await run({
      progressive: true,
      clock: () => 0,
      entry: list(3).map((e) => ({ ...e, url: `u${e.n}` })),
      blocks: [{ id: "nv", type: "list.new", params: { key: "url" } }, ...CHAIN_BLOCKS({ live: true }, { fiabilite: { onError: "fail" } })],
      registry: { "list.new": newList, ...chainRegistry(events, {}, { fiabilite: { failsOn: 2 } }) },
    });
    expect(r.error?.message).toBe("fiabilite raté");
    // u0 published; u1 finished afterwards (not published, under 5 s); then u2 fails.
    expect(publications(r).map((p) => p.data.map((e: any) => e.url))).toEqual([["u0"]]);
    expect(events.indexOf("end:avis:1")).toBeGreaterThanOrEqual(0);
    expect(events.indexOf("end:avis:1")).toBeLessThan(events.indexOf("end:fiabilite:2"));
    const last = r.traces.filter((l) => l.t === "memory").at(-1);
    expect(r.traces.at(-1)).toBe(last);
    // u1 was never shown: it comes back next time.
    expect(last.memory.nv.value.map((e: any) => e[0])).toEqual(["u0"]);
  });

  it("a publication over 2 MB (DATA_MAX_SIZE) is not sent, and none of its keys is retained before the end of the chain", async () => {
    const events: AppEvent[] = [];
    const clock = { t: 0 };
    const big = "x".repeat(1.2 * 1024 * 1024);
    // u0 finishes fast and is published alone (1.2 MB); u1, slow, finishes more than 5 s later: [u0, u1] would be 2.4 MB.
    const r = await run({
      progressive: true,
      clock: () => clock.t,
      entry: list(2).map((e) => ({ ...e, url: `u${e.n}`, big: big })),
      blocks: [{ id: "nv", type: "list.new", params: { key: "url" } }, ...CHAIN_BLOCKS()],
      registry: {
        "list.new": newList,
        ...chainRegistry(events, {}, { fiche: { clock: clock, duration: (n) => (n === 1 ? 9000 : 1000), turns: (n) => (n === 1 ? 50 : 1) } }),
      },
    });
    expect(r.error).toBeNull();
    expect(publications(r).map((p) => p.data.map((e: any) => e.url))).toEqual([["u0"]]);
    // Until the end of the chain, no memory retains u1 (never shown by a publication).
    const chainEnd = r.traces.findIndex((l) => l.t === "block" && l.step === "end" && l.id === "fiche");
    const memories = r.traces.slice(0, chainEnd).filter((l) => l.t === "memory");
    expect(memories.length).toBeGreaterThan(0);
    for (const m of memories) expect((m.memory.nv?.value ?? []).map((e: any) => e[0])).not.toContain("u1");
    // The output shows everything: u1 is retained at the end.
    expect((r.result!.memory.nv!.value as any[]).map((e) => e[0])).toEqual(["u0", "u1"]);
  });

  it("keys: the memory sent by verifierMemoire after the chain does not retain an element finished but not published; the output does", async () => {
    const clock = { t: 0 };
    const traces: any[] = [];
    const r = await runWorkflow({
      workflow: {
        // « lent », without a link, runs between the chain (fiche) and the output, and takes 40 s.
        blocks: [
          { id: "src", type: "test.source", params: {} },
          { id: "nv", type: "list.new", params: { key: "url" } },
          { id: "fiche", type: "test.fiche", params: { perItem: true, field: "page" } },
          { id: "lent", type: "test.lent", params: {} },
          { id: "sortie", type: "output", params: { live: true } },
        ],
        links: chain("src", "nv", "fiche", "sortie"),
        order: ["src", "nv", "fiche", "lent", "sortie"],
      },
      memory: {},
      now: "2026-10-29T10:00:00.000Z",
      folder: "/nulle-part",
      call: async () => null,
      trace: (m: any) => traces.push(m),
      blocks: {
        "test.source": { perItem: "no", run: async () => ({ output: [{ n: 0, url: "u0" }, { n: 1, url: "u1" }] }) },
        "list.new": newList,
        "test.fiche": step("fiche", []),
        "test.lent": {
          perItem: "no",
          async run() {
            clock.t += 40_000;
            return { output: null };
          },
        },
        output: { perItem: "no", run: async (ctx: any) => ({ output: ctx.input }) },
      },
      clock: () => clock.t,
      progressive: true,
    });
    expect(traces.filter((l) => l.t === "publication").map((p) => p.data.map((e: any) => e.url))).toEqual([["u0"]]);
    const iSlow = traces.findIndex((l) => l.t === "block" && l.id === "lent" && l.step === "end");
    const afterSlow = traces[iSlow + 1];
    expect(afterSlow.t).toBe("memory");
    expect(afterSlow.memory.nv.value.map((e: any) => e[0])).toEqual(["u0"]);
    expect(r.memory.nv.value.map((e: any) => e[0])).toEqual(["u0", "u1"]);
  });

  it("keys: the key lost before the chain then a failing element in the chain: nothing more is retained (R31)", async () => {
    const r = await run({
      progressive: true,
      entry: list(3).map((e) => ({ ...e, url: `u${e.n}` })),
      blocks: [
        { id: "nv", type: "list.new", params: { key: "url" } },
        { id: "remodeler", type: "test.remodeler" },
        ...CHAIN_BLOCKS(),
      ],
      registry: {
        "list.new": newList,
        "test.remodeler": { perItem: "no", run: async (ctx: any) => ({ output: ctx.input.map((e: any) => ({ n: e.n, address: e.url })) }) },
        ...chainRegistry([], {}, { avis: { failsOn: 0 } }),
      },
    });
    expect(r.error).toBeNull();
    expect(r.result!.memory.nv!.value).toEqual([]);
    expect(r.log("nv").join("\n")).toContain("n'est plus dans les éléments");
  });

  it("in the container: progressive debut and streaming output, the publication lines come before fin", async () => {
    const r = await launch({
      workflow: {
        version: 1,
        blocks: [
          block("src", "code", { source: "src.mjs" }),
          block("fiche", "source.page", { url: "https://x.fr/{url}", perItem: true, field: "page" }),
          block("sortie", "output", { to: "widget", live: true }),
        ],
        links: chain("src", "fiche", "sortie"),
      },
      files: { "src.mjs": `export default async () => [{ url: "a" }, { url: "b" }];` },
      reply: (a) => ({ ok: { url: a.a.url, title: "T", text: "texte", links: [] } }),
      start: { progressive: true },
    });
    expect(r.code).toBe(0);
    const pub = r.lines.find((l) => l.t === "publication");
    expect(pub).toMatchObject({ t: "publication", done: 1, total: 2 });
    expect(r.lines.indexOf(pub)).toBeLessThan(r.lines.findIndex((l) => l.t === "end"));
    expect(r.terminal.data).toHaveLength(2);
  });
});
