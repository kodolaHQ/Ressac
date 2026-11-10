import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tempFolder } from "../helpers/temp.js";
import { implicitWorkflow } from "../../src/workflows/validate.js";
import { pathToFileURL } from "node:url";
import { ENGINE, block, chain, launch as launchWorkflow, output, sentWorkflow } from "../helpers/engine.js";

const { SHIPPED_BLOCKS, GLOBAL_LIMIT_MS, deadlineOf, runWorkflow } = await import(pathToFileURL(join(ENGINE, "interpreter.mjs")).href);

const SCRIPT = join(import.meta.dirname, "..", "..", "docker", "engine", "harvester.mjs");

type Call = { t: "call"; n: number; f: string; a: any };
type Responder = (call: Call) => Promise<{ ok: unknown } | { error: string }> | { ok: unknown } | { error: string };

/** A widget that has only `harvest.mjs` (like the user's Gmail), launched the way the kernel does it. */
async function launch(code: string, reply: Responder = () => ({ ok: null }), config: unknown = {}) {
  const folder = await tempFolder();
  await writeFile(join(folder, "harvest.mjs"), code);
  const child = spawn("node", [SCRIPT, folder], { stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  const lines: any[] = [];
  const calls: Call[] = [];
  let buffer = "";
  const finished = new Promise<void>((ok) => child.on("close", () => ok()));
  child.stdout.on("data", (d) => {
    buffer += d;
    let i;
    while ((i = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      const m = JSON.parse(line);
      lines.push(m);
      if (m.t === "call") {
        calls.push(m);
        void Promise.resolve(reply(m)).then((r) => child.stdin.write(JSON.stringify({ t: "answer", n: m.n, ...r }) + "\n"));
      }
    }
  });
  child.stdin.write(
    JSON.stringify({ t: "start", previous: { v: 1 }, now: "2026-10-28T10:00:00.000Z", config, workflow: sentWorkflow(implicitWorkflow()) }) + "\n",
  );
  child.stdin.write(JSON.stringify({ t: "memory", memory: {} }) + "\n");
  await finished;
  return { lines, calls, stderr, terminal: lines.find((l) => l.t === "end" || l.t === "failure") };
}

describe("recolteur (implicit workflow of a lone harvest.mjs)", () => {
  it("a harvest.mjs that returns data produces { t: fin }", async () => {
    const r = await launch(
      `export default async (w) => ({ cfg: w.config, prev: w.previous, when: w.now });`,
      undefined,
      { a: 1 },
    );
    expect(r.terminal).toEqual({
      t: "end",
      data: { cfg: { a: 1 }, prev: { v: 1 }, when: "2026-10-28T10:00:00.000Z" },
    });
  });

  it("lirePage and kev go through numbered calls and receive the response", async () => {
    const r = await launch(
      `export default async (w) => {
        const p = await w.readPage("https://a.fr/", { account: true });
        const k = await w.kev("etat", { q: { type: "noul" } });
        return { p, k };
      };`,
      (a) =>
        a.f === "readPage"
          ? { ok: { url: a.a.url, title: "T", text: "x", links: [] } }
          : { ok: { q: { type: "noul", noul: 0.9 } } },
    );
    expect(r.calls.map((a) => [a.n, a.f])).toEqual([[1, "readPage"], [2, "kev"]]);
    expect(r.calls[0]!.a).toEqual({ url: "https://a.fr/", account: true });
    expect(r.calls[1]!.a).toEqual({ state: "etat", questions: { q: { type: "noul" } } });
    expect(r.terminal.data.k).toEqual({ q: { type: "noul", noul: 0.9 } });
    expect(r.terminal.data.p.title).toBe("T");
  });

  it("a widget exception gives { t: echec } with the message", async () => {
    const r = await launch(`export default async () => { throw new Error("boum"); };`);
    expect(r.terminal).toEqual({ t: "failure", error: expect.stringContaining("boum") });
  });

  it("a result that is not JSON gives echec", async () => {
    const r = await launch(`export default async () => () => 1;`);
    expect(r.terminal.t).toBe("failure");
  });

  it("a kernel { erreur } response becomes an exception in the widget", async () => {
    const r = await launch(
      `export default async (w) => { try { await w.fetch("https://x.fr/"); } catch (e) { return { caught: e.message }; } };`,
      () => ({ error: "domaine refusé" }),
    );
    expect(r.terminal).toEqual({ t: "end", data: { caught: "domaine refusé" } });
  });

  it("lireFlux reads an RSS 2.0 and an Atom (CDATA, entities)", async () => {
    const rss = `<?xml version="1.0"?><rss version="2.0"><channel><title>Mon &amp; flux</title>
      <item><title><![CDATA[Salut <b>toi</b>]]></title><link>https://a.fr/1</link><pubDate>Mon, 26 Oct 2026 10:00:00 GMT</pubDate><description>R&eacute;sum&#233; &lt;ok&gt; &quot;q&quot; it&apos;s</description></item>
      <item><title>Deux</title><link>https://a.fr/2</link></item></channel></rss>`;
    const atom = `<feed xmlns="http://www.w3.org/2005/Atom"><title>Atome</title>
      <entry><title>Un</title><link rel="alternate" href="https://b.fr/1"/><updated>2026-10-27T08:00:00Z</updated><summary><![CDATA[Le <i>résumé</i>]]></summary></entry></feed>`;
    const r = await launch(
      `export default async (w) => ({ rss: await w.readFeed("https://a.fr/rss"), atom: await w.readFeed("https://b.fr/atom") });`,
      (a) => {
        expect(a.f).toBe("fetch");
        expect(a.a).toEqual({ url: expect.any(String), format: "text" });
        return { ok: a.a.url.includes("a.fr") ? rss : atom };
      },
    );
    const d = r.terminal.data;
    expect(d.rss).toHaveLength(2);
    expect(d.rss[0]).toMatchObject({ title: "Salut <b>toi</b>", url: "https://a.fr/1", date: "Mon, 26 Oct 2026 10:00:00 GMT" });
    expect(d.rss[0].summary).toContain('<ok> "q" it\'s');
    expect(d.rss[1].title).toBe("Deux");
    expect(d.atom).toEqual([
      { title: "Un", url: "https://b.fr/1", date: "2026-10-27T08:00:00Z", summary: "Le <i>résumé</i>" },
    ]);
  });

  it("trier asks one noul question per element with the element in state, 8 at a time at most, and filters by threshold", async () => {
    let running = 0;
    let max = 0;
    const r = await launch(
      `export default async (w) => {
        const els = Array.from({ length: 20 }, (_, i) => ({ id: i, t: "el" + i }));
        return await w.sort(els, { question: "intéressant ?", text: (e) => e.t, threshold: 0.5 });
      };`,
      async (a) => {
        running++;
        max = Math.max(max, running);
        await new Promise((ok) => setTimeout(ok, 15));
        running--;
        const i = Number(a.a.state.slice(2));
        return { ok: { q: { type: "noul", noul: i / 20 } } };
      },
    );
    expect(r.calls).toHaveLength(20);
    expect(r.calls.every((a) => a.f === "kev" && /^el\d+$/.test(a.a.state))).toBe(true);
    expect(Object.values(r.calls[0]!.a.questions)[0]).toEqual({ type: "noul", instructions: "intéressant ?" });
    expect(JSON.stringify(r.calls[0]!.a.questions)).not.toContain("el0");
    expect(max).toBeLessThanOrEqual(8);
    expect(max).toBeGreaterThan(1);
    const res = r.terminal.data as { element: { id: number }; score: number }[];
    expect(res.map((x) => x.element.id)).toEqual([19, 18, 17, 16, 15, 14, 13, 12, 11, 10]);
    expect(res[0]!.score).toBeCloseTo(0.95);
  });

  it("a response over 4 MB rejects the call concerned with a clear error", async () => {
    const r = await launch(
      `export default async (w) => { try { await w.fetch("https://x.fr/"); } catch (e) { return { attrape: e.message }; } };`,
      () => ({ ok: "x".repeat(4 * 1024 * 1024 + 10) }),
    );
    expect(r.terminal.data.attrape).toContain("Réponse trop grande");
  });

  it("log written on stderr, never on stdout", async () => {
    const r = await launch(`export default async (w) => { w.log("bonjour", { a: 1 }); console.log("direct"); return 1; };`);
    expect(r.stderr).toContain("bonjour");
    expect(r.stderr).toContain("direct");
    // stdout carries only the protocol: the implicit block's traces, the memory, the end.
    expect(r.lines.map((l) => l.t)).toEqual(["block", "log", "block", "block", "block", "memory", "end"]);
    expect(r.lines.find((l) => l.t === "log")).toEqual({ t: "log", block: "harvest", text: expect.stringContaining("bonjour") });
    expect(r.terminal).toEqual({ t: "end", data: 1 });
  });
});

describe("recolteur: duration limit (limitMs)", () => {
  it("limitMs 1000: no more element launched after 1 s", async () => {
    // Fake clock: the deadline of the debut line received at 0, each element lasts 300 ms, two at a time.
    let now = 0;
    const launched: number[] = [];
    const traces: any[] = [];
    await runWorkflow({
      workflow: sentWorkflow(
        {
          version: 1,
          blocks: [block("liste", "code", { source: "liste.mjs" }), block("cherche", "web.search", { query: "{model}", perItem: true }), output],
          links: chain("liste", "cherche", "sortie"),
        },
        { web: true, maxDurationMinutes: 1, owner: "widget" as const, input: false },
      ),
      memory: {},
      now: "2026-10-29T10:00:00.000Z",
      folder: "/nulle-part",
      clock: () => now,
      deadline: deadlineOf({ t: "start", limitMs: 1000 }, 0),
      trace: (m: unknown) => traces.push(m),
      call: async () => {
        launched.push(now);
        await Promise.resolve();
        now += 300;
        return [];
      },
      blocks: { ...SHIPPED_BLOCKS, code: { perItem: "no", run: async () => ({ output: Array.from({ length: 20 }, (_, i) => ({ model: `m${i}` })) }) } },
    });
    // Pairs launched at 0, 600; at 1200, nothing more.
    expect(launched).toEqual([0, 0, 600, 600]);
    expect(traces.find((l) => l.t === "block" && l.id === "cherche" && l.step === "end")).toMatchObject({ status: "partial" });
    expect(traces).toContainEqual({ t: "log", block: "cherche", text: "temps écoulé : 16 élément(s) non lancé(s)" });
  });

  it("in the container, limitMs of the debut line is the deadline: 20 ms, elapsed during the list, no element launched", async () => {
    const r = await launchWorkflow({
      workflow: {
        version: 1,
        blocks: [block("liste", "code", { source: "liste.mjs" }), block("cherche", "web.search", { query: "{model}", perItem: true }), output],
        links: chain("liste", "cherche", "sortie"),
      },
      context: { web: true, maxDurationMinutes: 1, owner: "widget" as const, input: false },
      files: { "liste.mjs": `export default async () => { await new Promise((ok) => setTimeout(ok, 80)); return [{ model: "a" }, { model: "b" }]; };` },
      start: { limitMs: 20 },
      reply: () => ({ ok: [] }),
    });
    expect(r.calls).toEqual([]);
    expect(r.blockEnd("cherche")).toMatchObject({ status: "partial" });
  });

  it("without limitMs: 150 s as before", () => {
    expect(GLOBAL_LIMIT_MS).toBe(150_000);
    expect(deadlineOf({ t: "start" }, 1_000)).toBe(151_000);
    expect(deadlineOf({ t: "start", limitMs: 1_000 }, 1_000)).toBe(2_000);
  });
});
