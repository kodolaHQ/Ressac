import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SITE_CAPTURE_WARNING, HTML_MAX, PROJECT_ID, DESIGN_UNAVAILABLE, SITE_DESIGN_UNAVAILABLE, Remarks, TRUNCATED, type SpacePaths, type Batch, type TrackedProject } from "../../../packages/kernel/src/index";
import { RANGE_OUTSIDE_BLOCK } from "../shared/model";
import { UNKNOWN_COMPARISON, ReviewService } from "../host/review";
import * as g from "../shared/design-guards";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const EXT = "ext-0123456789abcdef";
const unknown = `${"a".repeat(40)}:${"b".repeat(40)}`;
const thirty = Array.from({ length: 30 }, (_, i) => `ligne ${i + 1}`);
/** a.txt of 30 lines, with the numbered lines rewritten. */
const text = (...changed: number[]) => thirty.map((l, i) => (changed.includes(i + 1) ? `${l} modifiée` : l)).join("\n") + "\n";

describe("review service", () => {
  function prepare() {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "webaios-review-")));
    dirs.push(root);
    const projects = join(root, "projects");
    const sites = join(root, "sites");
    mkdirSync(join(projects, "essai"), { recursive: true });
    mkdirSync(join(sites, "tuning", "tweaks"), { recursive: true });
    writeFileSync(join(projects, "essai", "a.txt"), "un\n");
    writeFileSync(join(sites, "tuning", "site.json"), "{}\n");
    writeFileSync(join(sites, "tuning", "tweaks", "tuning.css"), "/* rien */\n");
    const folders = { spaceRemarks: join(root, "remarks"), private: join(root, "prive") };
    const remarks = new Remarks({ folders: folders });
    const sent: { project: TrackedProject; batch: Batch }[] = [];
    const registry = {
      projects: () => [{ id: EXT.slice(4), name: "Ext", folder: join(projects, "essai"), ports: [], client: "client-0001", declared: "" }],
      clients: () => [{ id: "client-0001", name: "Claude", hash: "", created: "" }],
    };
    const service = new ReviewService({
      folders: folders, paths: { projects: projects, sites } as SpacePaths, registry: () => registry as never,
      sites: async () => [{ id: "tuning", name: "Tuning" }], remarks: remarks,
      send: async (project, batch) => void sent.push({ project: project, batch: batch }),
    });
    const review = join(folders.private, "review");
    return { service, remarks: remarks, sent, root, projects: projects, sites, review: review, write: (t: string, n = "a.txt") => writeFileSync(join(projects, "essai", n), t) };
  }
  /** Opens once so the project's first snapshot is taken, writes `before` first; returns after `after` is written. */
  async function opened(s: ReturnType<typeof prepare>, before: string, after: string) {
    s.write(before);
    await s.service.open(EXT);
    s.write(after);
    const v = await s.service.open(EXT);
    if (v.state !== "ok") throw new Error(v.reason);
    return v;
  }
  const ok = <T extends { state: string }>(v: T) => {
    if (v.state !== "ok") throw new Error(JSON.stringify(v));
    return v as T & { state: "ok"; token: string };
  };

  it("two opens give two tokens; an unknown token is refused", async () => {
    const s = prepare();
    await s.service.open(EXT);
    s.write("deux\n");
    const v1 = ok(await s.service.open(EXT));
    s.write("trois\n");
    const v2 = ok(await s.service.open(EXT));
    expect(v1.token).toMatch(g.REVIEW_TOKEN);
    expect(v2.token).not.toBe(v1.token);
    const added = async (j: string) => (await s.service.file(EXT, j, "a.txt")).blocks.flatMap((b) => b.lines.filter((l) => l.mark === "+").map((l) => l.text));
    expect(await added(v1.token)).toEqual(["deux"]);
    expect(await added(v2.token)).toEqual(["trois"]);
    expect(await s.service.lines(EXT, v1.token, "a.txt", 1, 5)).toEqual(["deux"]);
    s.write("quatre\n");
    expect(await s.service.open(EXT, v1.token)).toMatchObject({ state: "ok", token: v1.token });
    expect(await added(v1.token)).toEqual(["deux"]);
    await expect(s.service.file(EXT, unknown, "a.txt")).rejects.toThrow(UNKNOWN_COMPARISON);
    await expect(s.service.lines(EXT, unknown, "a.txt", 1, 2)).rejects.toThrow(UNKNOWN_COMPARISON);
  });

  it("keeps at most 8 comparisons per project: the oldest drops", async () => {
    const s = prepare();
    await s.service.open(EXT);
    const tokens: string[] = [];
    for (let i = 0; i < 9; i++) {
      s.write(`v${i}\n`);
      tokens.push(ok(await s.service.open(EXT)).token);
    }
    await expect(s.service.file(EXT, tokens[0]!, "a.txt")).rejects.toThrow(UNKNOWN_COMPARISON);
    expect((await s.service.file(EXT, tokens[1]!, "a.txt")).path).toBe("a.txt");
  }, 20_000);

  it("a range overflowing the block is refused", async () => {
    const s = prepare();
    const v = await opened(s, text(), text(5, 25));
    const c = (start: number, end: number, text: string, j = v.token) => s.service.comment(EXT, j, { file: "a.txt", start: start, end: end, text: text });
    expect(await c(5, 25, "trop large")).toEqual({ ok: false, error: RANGE_OUTSIDE_BLOCK });
    expect(await c(1, 3, "hors du diff")).toEqual({ ok: false, error: RANGE_OUTSIDE_BLOCK });
    expect(await c(4, 5, "  ")).toMatchObject({ ok: false });
    expect(await c(4, 5, "x", unknown)).toEqual({ ok: false, error: UNKNOWN_COMPARISON });
    expect(await c(4, 5, "bien")).toEqual({ ok: true });
    const [first] = await s.service.comments(EXT);
    expect(first).toMatchObject({ file: "a.txt", start: 4, end: 5, text: "bien", sent: false, resolved: false });
    expect(first!.lines).toEqual([{ mark: " ", text: "ligne 4" }, { mark: "-", text: "ligne 5" }, { mark: "+", text: "ligne 5 modifiée" }]);
  });

  it("relu keeps the tree shown: a file changed after ouvrir() stays in the next diff", async () => {
    const s = prepare();
    const v = await opened(s, "un\n", "deux\n");
    s.write("autre\n", "b.txt");
    const after = ok(await s.service.reviewed(EXT, v.token));
    expect(after.comparison.files.map((f) => f.path)).toEqual(["b.txt"]);
    await expect(s.service.reviewed(EXT, v.token)).rejects.toThrow(UNKNOWN_COMPARISON);
    await expect(s.service.reviewed(EXT, unknown)).rejects.toThrow(UNKNOWN_COMPARISON);
  });

  it("relu drops resolved comments and keeps the others", async () => {
    const s = prepare();
    const v = await opened(s, text(), text(15));
    await s.service.comment(EXT, v.token, { file: "a.txt", start: 15, end: 15, text: "un" });
    await s.service.comment(EXT, v.token, { file: "a.txt", start: 14, end: 14, text: "deux" });
    const [one] = await s.service.comments(EXT);
    await s.service.resolve(EXT, one!.id, true);
    const after = ok(await s.service.reviewed(EXT, v.token));
    expect(after.comparison.files).toEqual([]);
    expect(after.comments.map((c) => [c.text, c.file])).toEqual([["deux", "a.txt"]]);
  });

  it("envoyer makes a relecture lot with file, lines and marks; a second send takes the unresolved ones", async () => {
    const s = prepare();
    const v = await opened(s, text(), text(15));
    expect(v).toMatchObject({ destination: "Claude Code (Claude)", noDestination: null });
    expect(await s.service.send(EXT)).toMatchObject({ ok: false });
    await s.service.comment(EXT, v.token, { file: "a.txt", start: 15, end: 15, text: "garder l'ancien nom" });
    await s.service.comment(EXT, v.token, { file: "a.txt", start: 13, end: 14, text: "et ici" });
    expect(await s.service.send(EXT)).toEqual({ ok: true });
    const batches = await s.remarks.batches(EXT);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({ destination: "mcp" });
    expect(batches[0]!.items.map((e) => ({ type: e.type, text: e.text, context: e.context }))).toEqual([
      { type: "review", text: "garder l'ancien nom", context: { file: "a.txt", start: 15, end: 15, lines: [{ mark: "-", text: "ligne 15" }, { mark: "+", text: "ligne 15 modifiée" }] } },
      { type: "review", text: "et ici", context: { file: "a.txt", start: 13, end: 14, lines: [{ mark: " ", text: "ligne 13" }, { mark: " ", text: "ligne 14" }] } },
    ]);
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]!.project).toMatchObject({ type: "externe", project: EXT, client: "client-0001" });
    expect(s.sent[0]!.batch.id).toBe(batches[0]!.id);
    const left = await s.service.comments(EXT);
    expect(left.map((c) => c.sent)).toEqual([true, true]);
    await s.service.resolve(EXT, left[0]!.id, true);
    expect(await s.service.send(EXT)).toEqual({ ok: true });
    const all = await s.remarks.batches(EXT);
    expect(all).toHaveLength(2);
    expect(all.find((l) => l.id !== batches[0]!.id)!.items.map((e) => e.text)).toEqual(["et ici"]);
  });

  it("simultaneous comment operations lose nothing", async () => {
    const s = prepare();
    const v = await opened(s, text(), text(15));
    for (let i = 0; i < 8; i++) await s.service.comment(EXT, v.token, { file: "a.txt", start: 15, end: 15, text: `n${i}` });
    const ids = (await s.service.comments(EXT)).map((c) => c.id);
    await Promise.all([
      ...ids.slice(0, 4).map((id) => s.service.resolve(EXT, id, true)),
      ...ids.slice(4).map((id, i) => s.service.editComment(EXT, id, `modifié ${i}`)),
      s.service.open(EXT, v.token),
      s.service.comment(EXT, v.token, { file: "a.txt", start: 13, end: 14, text: "nouveau" }),
    ]);
    const l = await s.service.comments(EXT);
    expect(l).toHaveLength(9);
    expect(l.filter((c) => c.resolved).map((c) => c.id)).toEqual(ids.slice(0, 4));
    expect(l.filter((c) => c.text.startsWith("modifié")).map((c) => c.id)).toEqual(ids.slice(4));
  });

  it("an external project's own folder is never touched: no .git inside, the bare repository is private", async () => {
    const s = prepare();
    await opened(s, "un\n", "deux\n");
    expect(existsSync(join(s.projects, "essai", ".git"))).toBe(false);
    expect(readdirSync(s.review).filter((n) => n.endsWith(".git"))).toEqual([`${EXT}.git`]);
    expect((await s.service.project("ext-ffffffffffffffff"))).toBeNull();
    expect(await s.service.open("ext-ffffffffffffffff")).toMatchObject({ state: "indisponible", reason: "projet inconnu" });
  });

  it("a site folder that is a symlink gives null and creates no repository", async () => {
    for (const to of ["dehors", "dedans"] as const) {
      const s = prepare();
      rmSync(join(s.sites, "tuning"), { recursive: true });
      const target = to === "dehors" ? join(s.root, "dehors") : join(s.sites, "autre");
      mkdirSync(target);
      writeFileSync(join(target, "secret.txt"), "x\n");
      symlinkSync(target, join(s.sites, "tuning"));
      expect(await s.service.project("site-tuning")).toBeNull();
      await s.service.handleSites(["tuning"]);
      await s.service.ensure("site-tuning");
      expect(await s.service.open("site-tuning")).toMatchObject({ state: "indisponible", reason: "projet inconnu" });
      expect(existsSync(join(s.review, "site-tuning.git"))).toBe(false);
    }
  });

  it("a real site folder gives its name; an absent site gives null", async () => {
    const s = prepare();
    expect(await s.service.project("site-tuning")).toEqual({ name: "Tuning", folder: join(s.sites, "tuning") });
    expect(await s.service.project("site-absent")).toBeNull();
    mkdirSync(join(s.sites, "autre"));
    expect(await s.service.project("site-autre")).toEqual({ name: "autre", folder: join(s.sites, "autre") });
  });

  it("priseEnChargeSites snapshots valid sites only; assurer a second time does not move the reference", async () => {
    const s = prepare();
    await s.service.handleSites(["tuning", "../x"]);
    const ref = join(s.review, "site-tuning.git", "refs", "webaios", "relu");
    expect(existsSync(ref)).toBe(true);
    expect(readdirSync(s.review).filter((n) => n.endsWith(".git"))).toEqual(["site-tuning.git"]);
    const before = readFileSync(ref, "utf8");
    writeFileSync(join(s.sites, "tuning", "site.json"), '{"nom":"Tuning"}\n');
    await s.service.ensure("site-tuning");
    expect(readFileSync(ref, "utf8")).toBe(before);
    expect(existsSync(join(s.sites, "tuning", ".git"))).toBe(false);
    const v = ok(await s.service.open("site-tuning"));
    expect(v.comparison.files.map((f) => f.path)).toEqual(["site.json"]);
    expect(v).toMatchObject({ name: "Tuning", destination: "l'agent", noDestination: null });
  });

  it("assurer of a site takes its snapshot; of an app id or an unknown site it does nothing", async () => {
    const s = prepare();
    await s.service.ensure("app-essai");
    await s.service.ensure("site-absent");
    expect(existsSync(s.review)).toBe(false);
    await s.service.ensure("site-tuning");
    expect(existsSync(join(s.review, "site-tuning.git", "refs", "webaios", "relu"))).toBe(true);
  });

  it("envoyer of a site follows projectForSite", async () => {
    const s = prepare();
    const css = join(s.sites, "tuning", "tweaks", "tuning.css");
    writeFileSync(css, Array.from({ length: 5 }, (_, i) => `/* ${i} */`).join("\n") + "\n");
    await s.service.handleSites(["tuning"]);
    writeFileSync(css, ["/* 0 */", "/* 1 */", "a { color: red }", "/* 3 */", "/* 4 */"].join("\n") + "\n");
    const v = ok(await s.service.open("site-tuning"));
    expect(await s.service.comment("site-tuning", v.token, { file: "tweaks/tuning.css", start: 3, end: 3, text: "plus doux" })).toEqual({ ok: true });
    expect(await s.service.send("site-tuning")).toEqual({ ok: true });
    expect(s.sent[0]!.project).toEqual({ type: "site", project: "site-tuning", id: "tuning", name: "Tuning" });
  });

  it("effacer removes the repository and the comments file, and forgets the comparisons", async () => {
    const s = prepare();
    await s.service.handleSites(["tuning"]);
    writeFileSync(join(s.sites, "tuning", "site.json"), '{"a":1}\n');
    const v = ok(await s.service.open("site-tuning"));
    expect(await s.service.comment("site-tuning", v.token, { file: "site.json", start: 1, end: 1, text: "à voir" })).toEqual({ ok: true });
    expect(existsSync(join(s.review, "site-tuning.comments.json"))).toBe(true);
    await s.service.erase("site-tuning");
    expect(existsSync(join(s.review, "site-tuning.git"))).toBe(false);
    expect(existsSync(join(s.review, "site-tuning.comments.json"))).toBe(false);
    await expect(s.service.file("site-tuning", v.token, "site.json")).rejects.toThrow(UNKNOWN_COMPARISON);
    expect(await s.service.comments("site-tuning")).toEqual([]);
    await s.service.ensure("site-tuning");
    expect(await s.service.open("site-tuning")).toMatchObject({ state: "ok", comparison: { files: [] } });
  });

  it("a snapshot taken between effacer and the trash is erased by the second effacer, also after the trash", async () => {
    const s = prepare();
    await s.service.handleSites(["tuning"]);
    const ref = join(s.review, "site-tuning.git", "refs", "webaios", "relu");
    const first = s.service.erase("site-tuning");
    const photo = s.service.handleSites(["tuning"]);
    await Promise.all([first, photo]);
    expect(existsSync(ref)).toBe(true);
    const { renameSync } = await import("node:fs");
    renameSync(join(s.sites, "tuning"), join(s.root, "corbeille-tuning"));
    const late = s.service.handleSites(["tuning"]);
    await Promise.all([late, s.service.erase("site-tuning")]);
    expect(existsSync(join(s.review, "site-tuning.git"))).toBe(false);
    expect(existsSync(join(s.review, "site-tuning.comments.json"))).toBe(false);
    await s.service.handleSites(["tuning"]);
    expect(existsSync(join(s.review, "site-tuning.git"))).toBe(false);
  });
});

describe("design guards", () => {
  it("fixes the id, token and text bounds and the failure message", () => {
    expect(g.ID_PROJECT.source).toBe(PROJECT_ID.source);
    expect(g.REVIEW_TOKEN.source).toBe("^[0-9a-f]{40}:[0-9a-f]{40}$");
    expect(g.REMARK_TEXT_MAX).toBe(4000);
    expect(g.failureReason(new Error("x"))).toBe("Le MCP externe n'a pas pu démarrer : x");
    expect(g.failureReason("y")).toBe("Le MCP externe n'a pas pu démarrer : y");
    expect([g.EXTERNAL_ID.source, g.CLIENT_ID.source, g.REVIEW_PATH_MAX, g.COMMENT_ID.source, g.CLIENT_NAME_MAX]).toEqual(["^[0-9a-f]{16}$", "^[0-9a-f-]{8,64}$", 4096, "^c-[0-9a-f]{8}$", 200]);
  });

  it("each check accepts its edge case and refuses its neighbour with its message", () => {
    expect(g.checkProject(EXT)).toBe(EXT);
    expect(() => g.checkProject("ext-xyz")).toThrow("projet invalide");
    expect(() => g.checkProject(3)).toThrow("projet invalide");
    expect(g.checkToken(unknown)).toBe(unknown);
    expect(() => g.checkToken(`${"a".repeat(40)}:${"b".repeat(39)}`)).toThrow("jeton invalide");
    expect(g.checkPath("a".repeat(4096))).toHaveLength(4096);
    for (const bad of ["a".repeat(4097), "a\0b", "", 1]) expect(() => g.checkPath(bad)).toThrow("chemin invalide");
    expect(g.checkLines(3, 3)).toEqual([3, 3]);
    for (const [a, b] of [[0, 1], [1.5, 2], [2, 1], [1, 1.5], ["1", 2]]) expect(() => g.checkLines(a, b)).toThrow("lignes invalides");
    expect(g.checkText("a".repeat(4000))).toHaveLength(4000);
    for (const bad of ["a".repeat(4001), true]) expect(() => g.checkText(bad)).toThrow("texte invalide");
    expect(g.checkComment("c-0123abcd")).toBe("c-0123abcd");
    for (const bad of ["c-0123abc", "c-0123abcde", "x-0123abcd", 1]) expect(() => g.checkComment(bad)).toThrow("commentaire invalide");
    expect(g.checkResolved(false)).toBe(false);
    expect(() => g.checkResolved("true")).toThrow("résolu invalide");
    expect(g.checkClientName("a".repeat(200))).toHaveLength(200);
    for (const bad of ["a".repeat(201), 5]) expect(() => g.checkClientName(bad)).toThrow("Nom invalide");
  });

  it("design texts and bounds are kernel's", () => {
    expect(g.UNAVAILABLE_DESIGN).toBe(DESIGN_UNAVAILABLE);
    expect([g.UNAVAILABLE_DESIGN_SITE, g.CAPTURE_WARNING_SITE]).toEqual([SITE_DESIGN_UNAVAILABLE, SITE_CAPTURE_WARNING]);
    expect([g.HTML_MAX, g.TRUNCATED]).toEqual([HTML_MAX, TRUNCATED]);
    expect([g.INVALID_REQUEST, g.NOTHING_AIMED, g.DESIGN_ID_MAX]).toEqual(["Demande invalide", "Aucun élément visé.", 64]);
  });

  it("checkDesignContext: viewfinder.ts's rules, strict, known keys only", () => {
    const ok = {
      selector: "#b", label: "b", html: "a".repeat(HTML_MAX) + TRUNCATED, url: "http://x/", neighborhood: { parent: "p", siblings: [] },
      styles: { color: "red" }, source: { file: "a.svelte", line: 1, column: 2 }, view: { width: 1, height: 2 },
    };
    expect(g.checkDesignContext({ ...ok, rect: { x: 1 } })).toEqual(ok);
    expect(g.checkDesignContext({ ...ok, source: null }).source).toBeNull();
    for (const bad of [
      null, "x", { ...ok, html: "a".repeat(HTML_MAX + TRUNCATED.length + 1) }, { ...ok, view: { width: Infinity, height: 1 } },
      { ...ok, neighborhood: { parent: "p", siblings: [1] } }, { ...ok, styles: { a: null } }, { ...ok, label: 2 },
    ]) expect(() => g.checkDesignContext(bad)).toThrow(g.INVALID_REQUEST);
    // sourceSaine: a bad source field is dropped, the remark stays (a Svelte loc.column of 0 is real).
    expect(g.checkDesignContext({ ...ok, source: { file: "a", line: 0, column: 3 } }).source).toEqual({ file: "a", column: 3 });
    expect(g.checkDesignContext({ ...ok, source: { file: "a", line: 4, column: 1.5 } }).source).toEqual({ file: "a", line: 4 });
    for (const source of [undefined, "x", { file: "a".repeat(1025) }, { file: "" }, { line: 2 }]) expect(g.checkDesignContext({ ...ok, source }).source).toBeNull();
  });

  it("checkCapture: null, or a PNG of at most 8 MiB", () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(g.checkCapture(null)).toBeNull();
    expect(g.checkCapture(png.toString("base64"))).toEqual(png);
    const big = Buffer.concat([png, Buffer.alloc(g.CAPTURE_MAX - png.length)]);
    expect(g.checkCapture(big.toString("base64"))).toHaveLength(g.CAPTURE_MAX);
    for (const bad of [Buffer.concat([big, Buffer.alloc(1)]).toString("base64"), "iVBORw0K", Buffer.from("GIF89a!!!").toString("base64"), 1, undefined, ""])
      expect(() => g.checkCapture(bad)).toThrow(g.INVALID_REQUEST);
  });
});
