import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { spacePaths, ReviewStore, reviewStore, SPACE_FOLDER, EXTERNAL_MCP_PORT, externalProject, EMPTY_REMARK, NO_CLIENT } from "../../../packages/kernel/src/index";
import { NO_WINDOW } from "../core/design/send";
import { createDesignHost, DESIGN_METHODS, externalMcpPort, textSource, type DesignHost, type DesignTracking } from "../host/design";
import { INVALID_REQUEST } from "../shared/design-guards";
import { ReviewService } from "../host/review";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const c of cleanup.splice(0).reverse()) await c();
});

type Ext = { server: { state: string; port?: number; reason?: string }; projects: { id: string; name: string }[] };

type App = { folder: string; name: string; type: "app" | "poc" | "no-manifest"; createdAt: string; state: "stopped" | "running"; port?: number };
const app = (folder: string, type: App["type"] = "app"): App => ({ folder: folder, name: folder, type, createdAt: "2026-11-07T00:00:00.000Z", state: "stopped" });

function prepare(o: { port?: number; window?: string | null; sites?: { id: string; name: string }[]; siteApps?: App[] } = {}) {
  const dataDir = realpathSync(mkdtempSync(join(tmpdir(), "webaios-design-")));
  cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }));
  const paths = spacePaths(join(dataDir, "workspace"));
  mkdirSync(paths.sites, { recursive: true });
  // Outside <dataDir>: a project under it would be refused.
  const homeDir = realpathSync(mkdtempSync(join(tmpdir(), "webaios-maison-")));
  cleanup.push(() => rmSync(homeDir, { recursive: true, force: true }));
  const calls: string[] = [];
  const prefill = vi.fn((f: string, t: string) => void calls.push(`preRemplir ${f} ${t}`));
  const notify = vi.fn();
  const chrome = {
    agentWindow: vi.fn(async () => (o.window === undefined ? "f7" : o.window)),
    giveAgent: vi.fn((f: string) => void calls.push(`donnerAgent ${f}`)),
  };
  const sites = vi.fn(async () => o.sites ?? []);
  const apps = vi.fn(async () => o.siteApps ?? []);
  const broadcast = vi.fn();
  const design = createDesignHost({ dataDir, paths: paths, port: o.port ?? 0, home: homeDir, sites, siteApps: apps, prefill: prefill, chrome, notify: notify, broadcast });
  cleanup.push(() => design.stop());
  return { dataDir, paths: paths, home: homeDir, design, prefill: prefill, notify: notify, chrome, sites, siteApps: apps, diffuser: broadcast, calls };
}

async function until<T>(f: () => Promise<T> | T, ok: (v: T) => boolean, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timeout: ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const list = (d: DesignHost) => d.handlers["external.list"]!(undefined) as Promise<Ext>;
const ready = (d: DesignHost) => until(() => list(d), (e) => e.server.state !== "eteint" || e.server.reason !== "Le MCP externe démarre");

/** Connects a real MCP client with the token of « Brancher » and calls a tool, like a Claude Code would. */
async function callTool(d: DesignHost, name: string, args: Record<string, unknown>) {
  const { server: server } = await ready(d);
  const { command: command } = (await d.handlers["external.connect"]!({ name: "Claude Code" })) as { command: string };
  const token = /Bearer (\S+)"/.exec(command)![1]!;
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const client = new Client({ name: "test", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp-external`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }),
  );
  try {
    const r = (await client.callTool({ name, arguments: args })) as { content: { text?: string }[]; isError?: boolean };
    return { text: r.content.map((c) => c.text ?? "").join("\n"), error: r.isError === true };
  } finally {
    await client.close();
  }
}

/** A site app « tuning » with a changed file and one comment on it, ready for relecture.envoyer. */
async function siteWithComment(s: ReturnType<typeof prepare>) {
  const folder = join(s.paths.sites, "tuning");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "a.txt"), "un\n");
  const h = s.design.handlers;
  await h["review.open"]!({ project: "site-tuning", token: null });
  writeFileSync(join(folder, "a.txt"), "deux\n");
  const v = (await h["review.open"]!({ project: "site-tuning" })) as { state: string; token: string };
  expect(v.state).toBe("ok");
  expect(await h["review.comment"]!({ project: "site-tuning", token: v.token, c: { file: "a.txt", start: 1, end: 1, text: "Plus\r\nclair" } })).toEqual({ ok: true });
}

describe("design host", { timeout: 20_000 }, () => {
  it("externalMcpPort: 5279 by default, NaN for a bad value", () => {
    expect(externalMcpPort(undefined)).toBe(5279);
    expect(EXTERNAL_MCP_PORT).toBe(5279);
    expect(externalMcpPort("0")).toBe(0);
    expect(Number.isNaN(externalMcpPort("abc"))).toBe(true);
  });

  it("DESIGN_METHODS names every handler", () => {
    const s = prepare();
    expect([...DESIGN_METHODS].sort()).toEqual(Object.keys(s.design.handlers).sort());
  });

  it("registries are written under <dataDir>/design with mode 0600, never under <dataDir>/espace", async () => {
    const s = prepare();
    await ready(s.design);
    await s.design.handlers["external.connect"]!({ name: "Claude Code" });
    const file = join(s.dataDir, "design", "external-clients.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [e.name]));
    expect(walk(join(s.dataDir, "workspace")).filter((n) => n.includes("externes"))).toEqual([]);
  });

  it("declaring <dataDir>, <dataDir>/design/x or <dataDir>/workspace/projects/x is refused with SPACE_FOLDER", async () => {
    const s = prepare();
    const folders = [s.dataDir, join(s.dataDir, "design", "x"), join(s.paths.projects, "x")];
    for (const d of folders.slice(1)) mkdirSync(d, { recursive: true });
    for (const folder of folders) {
      const r = await callTool(s.design, "declare_project", { folder: folder, ports: [3000] });
      expect(r.text).toContain(SPACE_FOLDER);
    }
    expect((await list(s.design)).projects).toEqual([]);
  });

  // Review Focus 2
  it("a folder that links into <dataDir> is refused with SPACE_FOLDER", async () => {
    const s = prepare();
    mkdirSync(join(s.dataDir, "design"), { recursive: true });
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "webaios-lien-")));
    cleanup.push(() => rmSync(outside, { recursive: true, force: true }));
    const link = join(outside, "lien");
    symlinkSync(join(s.dataDir, "design"), link);
    const r = await callTool(s.design, "declare_project", { folder: link, ports: [3000] });
    expect(r.text).toContain(SPACE_FOLDER);
    expect((await list(s.design)).projects).toEqual([]);
    expect(existsSync(join(s.dataDir, "design", "external-projects.json"))).toBe(false);
    expect(existsSync(join(s.dataDir, "design", "review"))).toBe(false);
  });

  it("a first declaration notifies once", async () => {
    const s = prepare();
    const project = join(s.home, "projet");
    mkdirSync(project);
    await callTool(s.design, "declare_project", { folder: project, ports: [3000], name: "Projet" });
    await callTool(s.design, "declare_project", { folder: project, ports: [3001] });
    expect(s.notify).toHaveBeenCalledTimes(1);
    expect(s.notify).toHaveBeenCalledWith({ title: "WebAiOs", text: "Claude Code a branché le projet Projet" });
    const e = await list(s.design);
    expect(e.projects.map((p) => p.name)).toEqual(["Projet"]);
    expect(await s.design.handlers["external.name"]!({ id: e.projects[0]!.id })).toBe("Projet");
    expect(await s.design.handlers["external.name"]!({ id: "0123456789abcdef" })).toBeNull();
  });

  it("a batch reaches the window fenetreAgent gives, without \\r, then donnerAgent; an external project asks nothing of the chrome", async () => {
    const s = prepare({ sites: [{ id: "tuning", name: "Tuning" }] });
    await siteWithComment(s);
    expect(await s.design.handlers["review.send"]!({ project: "site-tuning" })).toEqual({ ok: true });
    expect(s.calls).toHaveLength(2);
    expect(s.calls[0]).toMatch(/^preRemplir f7 /);
    expect(s.calls[0]!.slice("preRemplir f7 ".length)).not.toMatch(/\r/);
    expect(s.calls[1]).toBe("donnerAgent f7");

    // An external project: its batch is in the MCP queue, the chrome is never asked.
    const project = join(s.home, "projet");
    mkdirSync(project);
    writeFileSync(join(project, "a.txt"), "un\n");
    await callTool(s.design, "declare_project", { folder: project, ports: [3000] });
    const id = `ext-${(await list(s.design)).projects[0]!.id}`;
    const h = s.design.handlers;
    await until(() => h["review.open"]!({ project: id }) as Promise<{ state: string }>, (v) => v.state === "ok");
    writeFileSync(join(project, "a.txt"), "deux\n");
    const v = (await h["review.open"]!({ project: id })) as { token: string };
    await h["review.comment"]!({ project: id, token: v.token, c: { file: "a.txt", start: 1, end: 1, text: "x" } });
    s.chrome.agentWindow.mockClear();
    expect(await h["review.send"]!({ project: id })).toEqual({ ok: true });
    expect(s.chrome.agentWindow).not.toHaveBeenCalled();
    expect(s.calls).toHaveLength(2);
  });

  it("fenetreAgent gives null: NO_WINDOW, and the batch stays written", async () => {
    const s = prepare({ window: null, sites: [{ id: "tuning", name: "Tuning" }] });
    await siteWithComment(s);
    expect(await s.design.handlers["review.send"]!({ project: "site-tuning" })).toEqual({ ok: false, error: NO_WINDOW });
    expect(s.prefill).not.toHaveBeenCalled();
    expect(readdirSync(join(s.paths.internal, "remarks", "site-tuning")).filter((n) => existsSync(join(s.paths.internal, "remarks", "site-tuning", n, "batch.json")))).toHaveLength(1);
  });

  it("a site: the app, its folder and the batch path, without \\r or \\n", async () => {
    const s = prepare({ sites: [{ id: "tuning", name: "Tuning" }] });
    await siteWithComment(s);
    await s.design.handlers["review.send"]!({ project: "site-tuning" });
    const [f, text] = s.prefill.mock.calls[0]!;
    expect(f).toBe("f7");
    expect(text).toContain('appli de site "Tuning" (/workspace/sites/tuning/)');
    expect(text).toMatch(/\/workspace\/\.webaios\/remarks\/site-tuning\/[^/]+\/batch\.json\] /);
    expect(text).not.toMatch(/[\r\n]/);
    expect(s.chrome.giveAgent).toHaveBeenCalledWith("f7");
  });

  it("a start that fails otherwise than a held port (bad port): off, with the reason", async () => {
    const s = prepare({ port: externalMcpPort("abc") });
    const e = await ready(s.design);
    expect(e.server.state).toBe("eteint");
    expect(e.server.reason).toMatch(/^Le MCP externe n'a pas pu démarrer : /);
    await expect(s.design.handlers["external.connect"]!({ name: "x" })).rejects.toThrow(/n'a pas pu démarrer/);
  });

  it("forgetting during the first snapshot: the private review repository does not come back", async () => {
    const s = prepare();
    await ready(s.design);
    const project = join(s.home, "site");
    mkdirSync(project);
    for (let i = 0; i < 50; i++) writeFileSync(join(project, `f${i}.txt`), `${i}\n`);
    const id = "0123456789abcdef";
    const folders = { spaceRemarks: join(s.paths.internal, "remarks"), private: join(s.dataDir, "design") };
    const repo = reviewStore(folders, externalProject(id));
    const photo = new ReviewStore({ repo, folder: project }).ensureReference().catch(() => undefined);
    await s.design.handlers["external.forget"]!({ id });
    await photo;
    expect(existsSync(repo)).toBe(false);
  });

  it("sitesChanged twice within 1 s takes one photo pass", async () => {
    const spy = vi.spyOn(ReviewService.prototype, "handleSites");
    const s = prepare({ sites: [{ id: "tuning", name: "Tuning" }] });
    await until(() => spy.mock.calls.length, (n) => n === 1);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    s.design.sitesChanged();
    vi.advanceTimersByTime(500);
    s.design.sitesChanged();
    vi.advanceTimersByTime(999);
    expect(s.sites).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    vi.useRealTimers();
    await until(() => spy.mock.calls.length, (n) => n === 2);
    expect(spy).toHaveBeenLastCalledWith(["tuning"]);
  });

  it("appsChanged twice within 1 s takes one photo pass, apps without manifest skipped", async () => {
    const spy = vi.spyOn(ReviewService.prototype, "handle");
    const s = prepare({ siteApps: [app("essai"), app("vieux", "no-manifest"), app("zod", "poc")] });
    // The first takeover, at start.
    await until(() => spy.mock.calls.length, (n) => n === 1);
    expect(spy).toHaveBeenLastCalledWith(["essai", "zod"]);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    s.design.appsChanged();
    vi.advanceTimersByTime(500);
    s.design.appsChanged();
    vi.advanceTimersByTime(999);
    expect(s.siteApps).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    vi.useRealTimers();
    await until(() => spy.mock.calls.length, (n) => n === 2);
    expect(spy).toHaveBeenLastCalledWith(["essai", "zod"]);
  });

  it("siteDeleted erases site-<id>.git, its comments and its lots", async () => {
    const s = prepare({ sites: [{ id: "tuning", name: "Tuning" }] });
    await siteWithComment(s);
    await s.design.handlers["review.send"]!({ project: "site-tuning" });
    const review = join(s.dataDir, "design", "review");
    const batches = join(s.paths.internal, "remarks", "site-tuning");
    expect(existsSync(join(review, "site-tuning.git"))).toBe(true);
    expect(existsSync(join(review, "site-tuning.comments.json"))).toBe(true);
    expect(existsSync(batches)).toBe(true);
    rmSync(join(s.paths.sites, "tuning"), { recursive: true });
    s.design.siteDeleted("tuning");
    await until(() => [join(review, "site-tuning.git"), join(review, "site-tuning.comments.json"), batches].some(existsSync), (v) => !v);
  });

  it("bad inputs are refused with their messages before the service", async () => {
    const s = prepare();
    const spy = vi.spyOn(ReviewService.prototype, "file");
    const h = s.design.handlers;
    const token = `${"a".repeat(40)}:${"b".repeat(40)}`;
    expect(() => h["review.file"]!({ project: "site-tuning", token: token, path: "../x\0" })).toThrow("chemin invalide");
    expect(() => h["review.file"]!({ project: "site-tuning", token: "a".repeat(39), path: "a.txt" })).toThrow("jeton invalide");
    expect(() => h["review.file"]!({ project: "../x", token: token, path: "a.txt" })).toThrow("projet invalide");
    expect(() => h["review.lines"]!({ project: "site-tuning", token: token, path: "a.txt", start: 3, end: 2 })).toThrow("lignes invalides");
    expect(() => h["review.comment"]!({ project: "site-tuning", token: token, c: null })).toThrow("lignes invalides");
    expect(() => h["review.resolve"]!({ project: "site-tuning", id: "c-00000001", resolved: "oui" })).toThrow("résolu invalide");
    expect(() => h["review.deleteComment"]!({ project: "site-tuning", id: "x" })).toThrow("commentaire invalide");
    expect(() => h["review.editComment"]!({ project: "site-tuning", id: "c-00000001", text: "x".repeat(4001) })).toThrow("texte invalide");
    expect(spy).not.toHaveBeenCalled();
    await expect(Promise.resolve().then(() => h["external.connect"]!({ name: "x".repeat(201) }))).rejects.toThrow("Nom invalide");
    // A bad id does nothing, as ipc.ts.
    await ready(s.design);
    expect(await h["external.revoke"]!({ id: "../x" })).toBeUndefined();
    expect(await h["external.forget"]!({ id: "zz" })).toBeUndefined();
  });
});

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const context = (o: Record<string, unknown> = {}) => ({
  selector: "#b", label: "button#b", html: "<button id=b>Ok</button>", url: "http://127.0.0.1:15283/",
  neighborhood: { parent: "main", siblings: ["p"] }, styles: { color: "red" }, source: { file: "src/A.svelte", line: 3 },
  view: { width: 800, height: 600 }, ...o,
});

describe("design host, the carts", { timeout: 20_000 }, () => {
  /** A demo on 15283 (in WEBAIOS_APP_PORTS), app-essai running on 15281, an external project on 3000. */
  async function withProjects(o: Parameters<typeof prepare>[0] = {}) {
    vi.stubEnv("WEBAIOS_APP_PORTS", "15280-15284");
    const s = prepare({ siteApps: [{ ...app("essai"), name: "Essai", state: "running", port: 15281 }, app("dort")], sites: [{ id: "x", name: "Site X" }], ...o });
    const project = join(s.home, "projet");
    mkdirSync(project);
    await callTool(s.design, "declare_project", { folder: project, ports: [3000], name: "Projet" });
    const ext = `ext-${(await list(s.design)).projects[0]!.id}`;
    return { ...s, ext, h: s.design.handlers };
  }
  const tracking = (h: DesignHost["handlers"], p: unknown) => h["design.tracking"]!(p) as Promise<DesignTracking | null>;

  it("design.suivi of a demo, an app running on its port, an external project's port, and nothing elsewhere", async () => {
    const { h, ext } = await withProjects();
    expect(await tracking(h, { url: "http://127.0.0.1:15283/" })).toEqual({
      project: { type: "demo", project: "demo-15283", port: 15283 }, basket: 0, destination: "l'agent", noDestination: null, name: "localhost:15283",
    });
    expect(await tracking(h, { url: "http://localhost:15281/a" })).toMatchObject({ project: { type: "app", project: "app-essai" }, name: "Essai" });
    expect(await tracking(h, { url: "http://localhost:3000/" })).toEqual({
      project: { type: "externe", project: ext, folder: expect.any(String), name: "Projet", client: expect.any(String) },
      basket: 0, destination: "Claude Code (Claude Code)", noDestination: null, name: "Projet",
    });
    expect(await tracking(h, { url: "https://exemple.test/" })).toBeNull();
    expect(await tracking(h, { url: "http://localhost:4999/" })).toBeNull();
    await expect(Promise.resolve().then(() => tracking(h, { url: `http://localhost:15283/${"a".repeat(8192)}` }))).rejects.toThrow(INVALID_REQUEST);
    await expect(Promise.resolve().then(() => tracking(h, {}))).rejects.toThrow(INVALID_REQUEST);
  });

  it("design.suivi of app-essai, site-x, demo-15283, an unknown ext- id", async () => {
    const { h } = await withProjects();
    expect(await tracking(h, { project: "app-essai" })).toMatchObject({ project: { type: "app", project: "app-essai", folder: "essai", name: "Essai" }, name: "Essai" });
    // Not running: only running apps are listed, so the name falls back to the folder.
    expect(await tracking(h, { project: "app-dort" })).toMatchObject({ name: "dort" });
    expect(await tracking(h, { project: "site-x" })).toMatchObject({ project: { type: "site", project: "site-x", id: "x", name: "Site X" }, destination: "l'agent" });
    expect(await tracking(h, { project: "site-y" })).toBeNull();
    expect(await tracking(h, { project: "demo-15283" })).toMatchObject({ project: { type: "demo", port: 15283 }, name: "localhost:15283" });
    expect(await tracking(h, { project: "ext-0123456789abcdef" })).toBeNull();
    await expect(Promise.resolve().then(() => tracking(h, { project: "../x" }))).rejects.toThrow("projet invalide");
  });

  it("ajouter puts the remark and its PNG in the cart; a blank text gives EMPTY_REMARK; 4001 characters, a non-PNG capture or a bad context give INVALID_REQUEST, nothing written", async () => {
    const { h, paths: paths } = await withProjects();
    const folder = join(paths.internal, "remarks", "demo-15283");
    const add = (o: Record<string, unknown>) => h["design.add"]!({ project: "demo-15283", text: "Plus grand", context: context(), capture: PNG.toString("base64"), ...o });
    const refused = [
      { text: "a".repeat(4001) },
      { text: 3 },
      { capture: Buffer.from("GIF89a").toString("base64") },
      { capture: 7 },
      { context: context({ html: "a".repeat(5000) }) },
      { context: context({ view: { width: Number.NaN, height: 1 } }) },
      { context: context({ styles: { color: 1 } }) },
      { context: null },
      { project: "../x" },
      { project: "ext-0123456789abcdef" },
    ];
    for (const r of refused) expect(await add(r), JSON.stringify(r).slice(0, 80)).toEqual({ ok: false, error: INVALID_REQUEST });
    expect(await add({ text: "  \n" })).toEqual({ ok: false, error: EMPTY_REMARK });
    expect(existsSync(folder)).toBe(false);

    expect(await add({ text: "a".repeat(4000), context: context({ extra: "x", source: null }) })).toEqual({ ok: true });
    expect(await add({ capture: null, context: context({ source: { file: "src/A.svelte", line: 3, column: 0 } }) })).toEqual({ ok: true });
    const basket = (await h["design.basket"]!({ project: "demo-15283" })) as { id: string; text: string; source: string | null }[];
    expect(basket.map((e) => [e.text.length, e.source])).toEqual([[4000, null], [10, "src/A.svelte:3"]]);
    expect(readFileSync(join(folder, `${basket[0]!.id}.png`))).toEqual(PNG);
    expect(existsSync(join(folder, `${basket[1]!.id}.png`))).toBe(false);
    // Only known keys are written.
    expect(readFileSync(join(folder, "basket.json"), "utf8")).not.toContain("extra");
    expect(await tracking(h, { project: "demo-15283" })).toMatchObject({ basket: 2 });
  });

  it("envoyer of a demo writes the lot under the space and asks the agent's window; of an external project without client gives NO_CLIENT", async () => {
    const { h, paths: paths, chrome, calls, ext, design, dataDir } = await withProjects();
    await h["design.add"]!({ project: "demo-15283", text: "Plus grand", context: context(), capture: null });
    expect(await h["design.send"]!({ project: "demo-15283" })).toEqual({ ok: true });
    const folder = join(paths.internal, "remarks", "demo-15283");
    expect(readdirSync(folder).filter((n) => existsSync(join(folder, n, "batch.json")))).toHaveLength(1);
    expect(chrome.agentWindow).toHaveBeenCalled();
    expect(calls).toEqual([expect.stringMatching(/^preRemplir f7 /), "donnerAgent f7"]);
    expect(await h["design.basket"]!({ project: "demo-15283" })).toEqual([]);
    expect(await h["design.batches"]!({ project: "demo-15283" })).toMatchObject([{ state: "pending", destination: "agent", items: [{ text: "Plus grand" }] }]);

    // The client revoked: no destination.
    const client = ((await list(design)).projects[0] as unknown as { client: string }).client;
    await h["external.revoke"]!({ id: client });
    await h["design.add"]!({ project: ext, text: "x", context: context(), capture: null });
    chrome.agentWindow.mockClear();
    expect(await h["design.send"]!({ project: ext })).toEqual({ ok: false, error: NO_CLIENT });
    expect(await h["design.send"]!({ project: "ext-0123456789abcdef" })).toEqual({ ok: false, error: NO_CLIENT });
    expect(await h["design.send"]!({ project: "../x" })).toEqual({ ok: false, error: INVALID_REQUEST });
    expect(chrome.agentWindow).not.toHaveBeenCalled();
    // An external project's cart stays under <dataDir>/design, never in the space.
    expect(existsSync(join(paths.internal, "remarks", ext))).toBe(false);
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
    expect(walk(join(dataDir, "design")).some((f) => f.includes(ext) && f.endsWith("basket.json"))).toBe(true);
  });

  it("traite marks the lot; an id of 65 characters does nothing", async () => {
    const { h } = await withProjects();
    await h["design.add"]!({ project: "demo-15283", text: "a", context: context(), capture: null });
    await h["design.add"]!({ project: "demo-15283", text: "b", context: context(), capture: null });
    const [a] = (await h["design.basket"]!({ project: "demo-15283" })) as { id: string }[];
    expect(await h["design.remove"]!({ project: "demo-15283", id: "x".repeat(65) })).toBeUndefined();
    expect(await h["design.remove"]!({ project: "demo-15283", id: 3 })).toBeUndefined();
    await h["design.remove"]!({ project: "demo-15283", id: a!.id });
    expect(((await h["design.basket"]!({ project: "demo-15283" })) as { text: string }[]).map((e) => e.text)).toEqual(["b"]);
    await h["design.send"]!({ project: "demo-15283" });
    const [batch] = (await h["design.batches"]!({ project: "demo-15283" })) as { id: string; state: string }[];
    expect(await h["design.handled"]!({ project: "demo-15283", batch: `${batch!.id}${"0".repeat(65 - batch!.id.length)}` })).toBeUndefined();
    expect(await h["design.batches"]!({ project: "demo-15283" })).toMatchObject([{ state: "pending" }]);
    await h["design.handled"]!({ project: "demo-15283", batch: batch!.id });
    expect(await h["design.batches"]!({ project: "demo-15283" })).toMatchObject([{ state: "handled" }]);
    // A bad project answers as ipc.ts: an empty list, or nothing.
    for (const project of ["../x", 3, undefined]) {
      expect(await h["design.basket"]!({ project: project })).toEqual([]);
      expect(await h["design.batches"]!({ project: project })).toEqual([]);
      expect(await h["design.remove"]!({ project: project, id: "e-00000000" })).toBeUndefined();
      expect(await h["design.handled"]!({ project: project, batch: batch!.id })).toBeUndefined();
    }
    expect(await h["design.basket"]!(null)).toEqual([]);
  });

  it("textSource joins the file and the line", () => {
    expect(textSource({ file: "a", line: 2 })).toBe("a:2");
  });
});
