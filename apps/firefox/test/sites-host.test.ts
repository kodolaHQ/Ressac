import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { storeSiteGrant, spacePaths, DeclarationSite, readSiteGrants, SiteMemory } from "../../../packages/kernel/src/index";
import { editWithAgent } from "../shared/sites";
import { createSites, grantRequest, rightsHash, SiteRecords, type SitesChrome } from "../host/sites";
import { SchemaActionSite } from "../shared/api";

// A gate on readSite: while armed, the next call waits (a slow read, for the deletion race).
const gate: { armed: boolean; reached: (() => void) | null; open: (() => void) | null } = { armed: false, reached: null, open: null };
vi.mock("../../../packages/kernel/src/index", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../../packages/kernel/src/index")>();
  return {
    ...real,
    readSite: async (...a: Parameters<typeof real.readSite>) => {
      if (gate.armed) {
        gate.armed = false;
        await new Promise<void>((ok) => {
          gate.open = ok;
          gate.reached?.();
        });
      }
      return real.readSite(...a);
    },
  };
});

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  gate.armed = false;
  gate.open?.();
  for (const c of cleanup.splice(0)) await c();
});

const declaration = {
  name: "Vidola",
  description: "Séries",
  url: "https://vidola-a.example/",
  domains: ["vidola-a.example", "vidola-b.example"],
  tweaks: [],
  resume: true,
};

function mount(gateOpen?: { reached: () => void; open: Promise<void> }, readLinks: (page: string, signal?: AbortSignal) => Promise<string[]> = async () => []) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sites-host-")));
  const paths = spacePaths(join(root, "workspace"));
  const dataDir = join(root, "profil");
  mkdirSync(dataDir, { recursive: true });
  const write = (id: string, text: string) => {
    mkdirSync(join(paths.sites, id), { recursive: true });
    writeFileSync(join(paths.sites, id, "site.json"), text);
  };
  write("vidola", JSON.stringify(declaration));
  writeFileSync(join(paths.sites, "vidola", "garde.txt"), "x");
  write("suivi", JSON.stringify({ ...declaration, domains: ["vidola-a.example"], urlTracking: { page: "https://adresses.example/", pattern: "vidola" } }));
  write("casse", "{pas du json");
  write("MonSite", JSON.stringify(declaration));
  const log: string[] = [];
  const calls: {
    open: unknown[][];
    updates: Parameters<SitesChrome["update"]>[0][];
    tweaks: Parameters<SitesChrome["update"]>[1][];
    reloads: string[];
    home: string[];
    after: unknown[][];
    rebroadcast: string[];
    tracking: unknown[][];
  } = {
    tracking: [],
    after: [],
    rebroadcast: [],
    open: [],
    updates: [],
    tweaks: [],
    reloads: [],
    home: [],
  };
  let chromeErrors: Awaited<ReturnType<SitesChrome["errors"]>> = [];
  let chromeOpened: string[] = [];
  let chromeView: Awaited<ReturnType<SitesChrome["view"]>> = null;
  /** While set, fermer waits for it (a deletion in progress). */
  let kept: Promise<void> | null = null;
  const chrome: SitesChrome = {
    open: async (...a) => {
      calls.open.push(a);
      log.push("open");
      if (gateOpen) {
        gateOpen.reached();
        await gateOpen.open;
      }
      return true;
    },
    close: async (id) => {
      log.push(`fermer ${id}`);
      await kept;
    },
    view: async () => chromeView,
    afterGrant: async (...a) => void calls.after.push(a),
    rebroadcast: async (id) => void calls.rebroadcast.push(id),
    erase: async (id) => void log.push(`effacer ${id}`),
    update: async (s, r) => {
      calls.updates.push(s);
      calls.tweaks.push(r);
      return false;
    },
    reloadView: async (id) => void calls.reloads.push(id),
    errors: async () => chromeErrors,
    openSites: async () => chromeOpened,
    homeChange: (id) => void calls.home.push(id),
    search: (...a) => void calls.tracking.push(["cherche", ...a]),
    notice: (...a) => void calls.tracking.push(["avis", ...a]),
    urlChanged: (...a) => void calls.tracking.push(["adresseChangee", ...a]),
  };
  const broadcast = vi.fn();
  const prefill = vi.fn();
  const memories: { id: string; message: unknown }[] = [];
  const sites = createSites({ paths: paths, dataDir, localAddresses: false, readLinks: readLinks, chrome, broadcast, prefill: prefill, notifyMemory: (id, message) => void memories.push({ id, message }) });
  cleanup.push(async () => {
    await sites.stop();
    rmSync(root, { recursive: true, force: true });
  });
  return { sites, paths: paths, dataDir, calls, log: log, diffuser: broadcast, prefill: prefill, memories: memories, write, setOpen: (o: string[]) => (chromeOpened = o),
    setView: (v: typeof chromeView) => (chromeView = v),
    keep: (p: Promise<void> | null) => (kept = p), setErrors: (e: typeof chromeErrors) => (chromeErrors = e) };
}

describe("lookupAddress", () => {
  const NOTICE_CHANGED = "Vidola a changé d'adresse : vidola-b.example. Il faudra peut-être te reconnecter.";

  it("a new domain: the bar is told (reading, new address, notice), url.json is written, the open app takes it", async () => {
    const m = mount(undefined, async () => ["https://adresses.example/x", "https://vidola-b.example/"]);
    await m.sites.openById("suivi");
    await m.sites.lookupAddress("suivi", "https://vidola-a.example/serie/1");
    expect(m.calls.tracking).toEqual([
      ["cherche", "suivi", true],
      ["cherche", "suivi", false],
      ["adresseChangee", "suivi", ["vidola-a.example", "vidola-b.example"], "https://vidola-b.example/", "https://vidola-b.example/serie/1"],
      ["avis", "suivi", { kind: "url-changed", text: NOTICE_CHANGED }],
    ]);
    expect(JSON.parse(readFileSync(join(m.dataDir, "sites", "suivi", "url.json"), "utf8"))).toMatchObject({ current: "vidola-b.example", previous: ["vidola-a.example"] });
    expect(m.sites.openSites.get("suivi")).toMatchObject({ domains: ["vidola-a.example", "vidola-b.example"], start: "https://vidola-b.example/" });
    expect(m.sites.openSites.get("suivi")!.request.tracked).toEqual(["vidola-b.example"]);
  });

  it("nothing to follow (no addressTracking, not open, deleting): no reading", async () => {
    const readLinks = vi.fn(async () => ["https://vidola-b.example/"]);
    const m = mount(undefined, readLinks);
    await m.sites.openById("vidola");
    await m.sites.lookupAddress("vidola", null);
    await m.sites.lookupAddress("suivi", null);
    expect(readLinks).not.toHaveBeenCalled();
    expect(m.calls.tracking).toEqual([]);
  });

  it("too early gives the last notice again, without a second reading", async () => {
    const readLinks = vi.fn(async () => []);
    const m = mount(undefined, readLinks);
    await m.sites.openById("suivi");
    await m.sites.lookupAddress("suivi", null);
    const first = m.calls.tracking.filter((c) => c[0] === "avis");
    expect(first).toEqual([["avis", "suivi", { kind: "not-found", text: "Adresse introuvable sur adresses.example" }]]);
    await m.sites.lookupAddress("suivi", null);
    expect(readLinks).toHaveBeenCalledTimes(1);
    expect(m.calls.tracking.filter((c) => c[0] === "avis")).toEqual([...first, ...first]);
  });

  it("the window closes during the reading: it is aborted and nothing is sent after", async () => {
    let signal: AbortSignal | undefined;
    let release: (l: string[]) => void = () => {};
    const m = mount(undefined, (_p, s) => {
      signal = s;
      return new Promise((ok) => (release = ok));
    });
    await m.sites.openById("suivi");
    const done = m.sites.lookupAddress("suivi", null);
    await vi.waitFor(() => expect(signal).toBeDefined());
    m.sites.closed("suivi");
    expect(signal!.aborted).toBe(true);
    release(["https://vidola-b.example/"]);
    await done;
    expect(m.calls.tracking).toEqual([["cherche", "suivi", true]]);
    expect(existsSync(join(m.dataDir, "sites", "suivi", "url.json"))).toBe(false);
  });

  it("a deletion aborts the reading too", async () => {
    let signal: AbortSignal | undefined;
    const m = mount(undefined, (_p, s) => {
      signal = s;
      return new Promise(() => {});
    });
    await m.sites.openById("suivi");
    void m.sites.lookupAddress("suivi", null);
    await vi.waitFor(() => expect(signal).toBeDefined());
    await m.sites.dispatch("suivi", "delete", "f1");
    expect(signal!.aborted).toBe(true);
  });
});

describe("list", () => {
  it("shows the current domain, the error of a broken site.json, and no actions for a refused id", async () => {
    const m = mount();
    mkdirSync(join(m.dataDir, "sites", "vidola"), { recursive: true });
    writeFileSync(join(m.dataDir, "sites", "vidola", "url.json"), JSON.stringify({ current: "vidola-b.example", previous: ["vidola-a.example"], since: null }));
    const l = await m.sites.list();
    const vidola = l.find((s) => s.id === "vidola")!;
    expect(vidola).toMatchObject({ name: "Vidola", open: false });
    expect(vidola.domain).toBe("vidola-b.example");
    expect(vidola).not.toHaveProperty("empreinte");
    expect(l.find((s) => s.id === "casse")!.error).toMatch(/site\.json/);
    expect(l.find((s) => s.id === "MonSite")).toMatchObject({ noActions: true });
  });
});

describe("openById", () => {
  it("opens with domains, start address, home flag and the remembered frame; unknown or invalid ids do not call the chrome", async () => {
    const m = mount();
    m.sites.note("vidola", { frame: { x: 1, y: 2, width: 300, height: 400 } });
    expect(await m.sites.openById("vidola")).toBe(true);
    const [site, frame] = m.calls.open[0]!;
    expect(site).toMatchObject({ id: "vidola", domains: ["vidola-a.example", "vidola-b.example"], start: "https://vidola-a.example/", hasHome: false });
    expect(frame).toEqual({ x: 1, y: 2, width: 300, height: 400 });
    expect(m.calls.open[0]![2]).toEqual({ js: {}, css: {} });
    expect((await m.sites.list()).find((s) => s.id === "vidola")!.open).toBe(true);
    for (const id of ["absente", "casse", "MonSite", "../x"]) expect(await m.sites.openById(id)).toBe(false);
    expect(m.calls.open).toHaveLength(1);
  });

  it("resynchroniser takes the chrome's open windows; fermee forgets one", async () => {
    const m = mount();
    m.setOpen(["vidola"]);
    await m.sites.resync();
    expect((await m.sites.list()).find((s) => s.id === "vidola")!.open).toBe(true);
    m.sites.closed("vidola");
    expect((await m.sites.list()).find((s) => s.id === "vidola")!.open).toBe(false);
  });
});

describe("agir", () => {
  it("modifier pre-fills the agent terminal; relire and dossier do nothing here", async () => {
    const m = mount();
    await m.sites.dispatch("vidola", "edit", "f1");
    expect(m.prefill).toHaveBeenCalledWith("f1", editWithAgent("vidola"));
    await m.sites.dispatch("vidola", "review", "f1");
    await m.sites.dispatch("vidola", "folder", "f1");
    expect(m.prefill).toHaveBeenCalledTimes(1);
    expect(m.log).toEqual([]);
  });

  it("oublier deletes memory.json and tells a subscribed home screen the memory is empty", async () => {
    const m = mount();
    const mem = await SiteMemory.open(join(m.dataDir, "sites"), "vidola");
    mem.keep("serie", { a: 1 }, "/s");
    await mem.clear();
    const file = join(m.dataDir, "sites", "vidola", "memory.json");
    expect(existsSync(file)).toBe(true);
    await m.sites.openById("vidola");
    const before = await m.sites.homeMemory("vidola");
    expect(before).toMatchObject({ type: "memory", domain: "vidola-a.example" });
    expect(Object.keys(before!.values)).toEqual(["serie"]);
    await m.sites.dispatch("vidola", "forget", "f1");
    expect(existsSync(file)).toBe(false);
    await vi.waitFor(() => expect(m.memories.at(-1)).toMatchObject({ id: "vidola", message: { type: "memory", values: {} } }));
    expect(readdirSync(join(m.paths.sites, "vidola")).sort()).toEqual(["garde.txt", "site.json"]);
  });

  it("supprimer closes then erases in the chrome, wipes the profile data and trashes the folder", async () => {
    const m = mount();
    await storeSiteGrant(m.dataDir, "vidola", DeclarationSite.parse(declaration));
    mkdirSync(join(m.dataDir, "sites", "vidola"), { recursive: true });
    writeFileSync(join(m.dataDir, "sites", "vidola", "url.json"), "{}");
    m.sites.note("vidola", { favicon: "data:x" });
    await m.sites.openById("vidola");
    await m.sites.dispatch("vidola", "delete", "f1");
    expect(m.log.filter((j) => /^(fermer|effacer)/.test(j))).toEqual(["fermer vidola", "effacer vidola"]);
    expect(existsSync(join(m.dataDir, "sites", "vidola"))).toBe(false);
    expect(Object.hasOwn(await readSiteGrants(m.dataDir), "vidola")).toBe(false);
    const trash = readdirSync(join(m.paths.sites, ".trash"));
    expect(trash).toHaveLength(1);
    expect(trash[0]).toMatch(/^vidola-\d+$/);
    expect(existsSync(join(m.paths.sites, "vidola"))).toBe(false);
    expect(existsSync(join(m.paths.sites, ".trash", trash[0]!, "site.json"))).toBe(true);
    // The favicon memory is forgotten (written after the 500 ms delay, or on stop).
    await m.sites.stop();
    const sites = existsSync(join(m.dataDir, "sites.json")) ? JSON.parse(readFileSync(join(m.dataDir, "sites.json"), "utf8")) : {};
    expect(sites.vidola).toBeUndefined();
  });

  it("a failed trash shows its text on the row", async () => {
    const m = mount();
    writeFileSync(join(m.paths.sites, ".trash"), "un fichier, pas un dossier");
    await m.sites.dispatch("vidola", "delete", "f1");
    const line = (await m.sites.list()).find((s) => s.id === "vidola")!;
    expect(line.actionError).toBe("Dossier non mis à la corbeille : la connexion et la mémoire sont effacées, le dossier reste.");
    expect(existsSync(join(m.paths.sites, "vidola"))).toBe(true);
  });

  it("refuses a path id and a refused id; an unknown folder is neither forgotten nor deleted", async () => {
    const m = mount();
    await m.sites.dispatch("../x", "delete", "f1");
    await m.sites.dispatch("MonSite", "delete", "f1");
    await m.sites.dispatch("inconnu", "delete", "f1");
    expect(m.log).toEqual([]);
    expect(existsSync(join(m.paths.sites, ".trash"))).toBe(false);
    expect(existsSync(join(m.paths.sites, "MonSite"))).toBe(true);
  });

  it("deleting during a slow open: the chrome is never asked to open; a concurrent second delete does nothing", async () => {
    const m = mount();
    const wasReached = new Promise<void>((ok) => (gate.reached = ok));
    gate.armed = true;
    const opening = m.sites.openById("vidola");
    await wasReached;
    const a = m.sites.dispatch("vidola", "delete", "f1");
    const b = m.sites.dispatch("vidola", "delete", "f1");
    gate.open!();
    expect(await opening).toBe(false);
    await Promise.all([a, b]);
    expect(m.calls.open).toHaveLength(0);
    expect(m.log.filter((j) => j === "fermer vidola")).toHaveLength(1);
    expect(readdirSync(join(m.paths.sites, ".trash"))).toHaveLength(1);
  });
});

describe("deleting while the chrome opens the window", () => {
  it("closes the window opened meanwhile and does not mark it open", async () => {
    let release!: () => void;
    let wasReached!: () => void;
    const reached = new Promise<void>((ok) => (wasReached = ok));
    const m = mount({ reached: () => wasReached(), open: new Promise<void>((ok) => (release = ok)) });
    const opening = m.sites.openById("vidola");
    await reached;
    const deletion = m.sites.dispatch("vidola", "delete", "f1");
    await vi.waitFor(() => expect(m.log).toContain("effacer vidola"));
    release();
    expect(await opening).toBe(false);
    await deletion;
    expect(m.log.at(-1)).toBe("fermer vidola");
    expect((await m.sites.list()).find((s) => s.id === "vidola")?.open ?? false).toBe(false);
  });
});

describe("watching", () => {
  it("a site.json rewritten with one domain less updates the open window and broadcasts; an accueil/ change reaches the chrome", async () => {
    const m = mount();
    await m.sites.openById("vidola");
    // Let the watcher settle before writing.
    await new Promise((r) => setTimeout(r, 400));
    m.diffuser.mockClear();
    m.write("vidola", JSON.stringify({ ...declaration, domains: ["vidola-a.example"] }));
    await vi.waitFor(() => expect(m.calls.updates.length).toBeGreaterThan(0), { timeout: 5000 });
    expect(m.calls.updates.at(-1)!.domains).toEqual(["vidola-a.example"]);
    expect(m.diffuser).toHaveBeenCalled();
    mkdirSync(join(m.paths.sites, "vidola", "home"), { recursive: true });
    writeFileSync(join(m.paths.sites, "vidola", "home", "index.html"), "<p>x</p>");
    await vi.waitFor(() => expect(m.calls.home).toContain("vidola"), { timeout: 5000 });
  });
});

describe("tweaks", () => {
  const withTweaks = { ...declaration, tweaks: [{ matches: ["/*"], js: ["a.js"], css: ["a.css"] }] };
  const write = (m: ReturnType<typeof mount>, f: string, text: string) => {
    mkdirSync(join(m.paths.sites, "vidola", "tweaks"), { recursive: true });
    writeFileSync(join(m.paths.sites, "vidola", "tweaks", f), text);
  };

  it("opens with the tweaks' files, the grant card and the hash", async () => {
    const m = mount();
    m.write("vidola", JSON.stringify(withTweaks));
    write(m, "a.js", "window.a = 1");
    write(m, "a.css", "p {}");
    await m.sites.openById("vidola");
    const [site, frame, tweaks] = m.calls.open[0]!;
    expect(frame).toBeNull();
    expect(tweaks).toEqual({ js: { "a.js": "window.a = 1" }, css: { "a.css": "p {}" } });
    expect(site).toMatchObject({ grantRequired: true, request: { name: "Vidola", files: ["a.js", "a.css"], hash: expect.stringMatching(/^[0-9a-f]{64}$/) }, hash: expect.any(String) });
    expect(m.sites.openSites.get("vidola")).toBe(site);
  });

  it("rewriting retouches/a.js updates the chrome then reloads the view once; the same content does not reload", async () => {
    const m = mount();
    m.write("vidola", JSON.stringify(withTweaks));
    write(m, "a.js", "window.a = 1");
    write(m, "a.css", "p {}");
    await m.sites.openById("vidola");
    await new Promise((r) => setTimeout(r, 400));
    write(m, "a.js", "window.a = 2");
    await vi.waitFor(() => expect(m.calls.reloads).toEqual(["vidola"]), { timeout: 5000 });
    expect(m.calls.tweaks.at(-1)).toEqual({ js: { "a.js": "window.a = 2" }, css: { "a.css": "p {}" } });
    const updates = m.calls.updates.length;
    write(m, "a.js", "window.a = 2");
    await vi.waitFor(() => expect(m.calls.updates.length).toBeGreaterThan(updates), { timeout: 5000 });
    await new Promise((r) => setTimeout(r, 300));
    expect(m.calls.reloads).toEqual(["vidola"]);
  });

  it("memoireOp: only an open app with its grant; the address is the chrome's", async () => {
    const m = mount();
    const op = { id: "vidola", url: "/serie/x", op: "remember", key: "k", value: 1 };
    expect(await m.sites.memoryOp(op)).toMatchObject({ ok: false });
    await m.sites.openById("vidola");
    // reprise: true asks for the grant.
    expect(await m.sites.memoryOp(op)).toMatchObject({ ok: false });
    m.sites.closed("vidola");
    await storeSiteGrant(m.dataDir, "vidola", DeclarationSite.parse(declaration));
    await m.sites.openById("vidola");
    expect(await m.sites.memoryOp(op)).toEqual({ ok: true });
    expect(await m.sites.memoryOp({ ...op, op: "read" })).toEqual({ ok: true, value: 1 });
    expect((await m.sites.tools.memory("vidola"))!.values.k).toMatchObject({ url: "/serie/x" });
    m.sites.closed("vidola");
    expect(await m.sites.memoryOp({ ...op, op: "read" })).toMatchObject({ ok: false });
  });

  it("position and reprise: only an open app with its grant; « Oublier » drops a note waiting for its second", async () => {
    const m = mount();
    const note = (t: number) => m.sites.position({ id: "vidola", frame: "1:2", url: "/episode/4", t, duration: 90 });
    await m.sites.openById("vidola");
    await note(70);
    expect(await m.sites.resume({ id: "vidola", url: "/episode/4", duration: 90 })).toBeNull();
    expect((await m.sites.tools.memory("vidola"))!.positions).toEqual({});
    m.sites.closed("vidola");
    await storeSiteGrant(m.dataDir, "vidola", DeclarationSite.parse(declaration));
    await m.sites.openById("vidola");
    await note(70);
    expect(await m.sites.resume({ id: "vidola", url: "/episode/4", duration: 91 })).toBe(70);
    // A second note too soon waits; « Oublier » (the real action) drops it, the memory stays empty.
    void note(75);
    await m.sites.dispatch("vidola", "forget", "f1");
    await new Promise((r) => setTimeout(r, 1300));
    expect((await m.sites.tools.memory("vidola"))!.positions).toEqual({});
    m.sites.closed("vidola");
    expect(await m.sites.resume({ id: "vidola", url: "/episode/4", duration: 90 })).toBeNull();
  });
});

describe("accorder", () => {
  const withTweaks = { ...declaration, tweaks: [{ matches: ["/*"], js: ["a.js"], css: [] }] };
  async function opened() {
    const m = mount();
    m.write("vidola", JSON.stringify(withTweaks));
    mkdirSync(join(m.paths.sites, "vidola", "tweaks"), { recursive: true });
    writeFileSync(join(m.paths.sites, "vidola", "tweaks", "a.js"), "window.a = 1");
    await m.sites.openById("vidola");
    const site = m.sites.openSites.get("vidola")!;
    m.setView("grant");
    return { m, site };
  }
  const grants = (m: { dataDir: string }) => readSiteGrants(m.dataDir);

  it("with the card's hash: writes the grant, tells the chrome (grant now covers), reads again without reloading", async () => {
    const { m, site } = await opened();
    expect(site.grantRequired).toBe(true);
    await m.sites.grant("vidola", true, site.request.hash);
    expect(Object.keys(await grants(m))).toEqual(["vidola"]);
    expect(m.calls.after).toEqual([["vidola", expect.objectContaining({ grantRequired: false })]]);
    await vi.waitFor(() => expect(m.calls.updates.length).toBeGreaterThan(0), { timeout: 5000 });
    await new Promise((r) => setTimeout(r, 200));
    expect(m.calls.reloads).toEqual([]);
  });

  it("a stale hash: nothing is written, the chrome shows the card again", async () => {
    const { m } = await opened();
    await m.sites.grant("vidola", true, "0".repeat(64));
    expect(await grants(m)).toEqual({});
    expect(m.calls.after).toEqual([]);
    expect(m.calls.rebroadcast).toEqual(["vidola"]);
  });

  it("« Ouvrir sans retouches »: the next view without any grant", async () => {
    const { m, site } = await opened();
    await m.sites.grant("vidola", false, site.request.hash);
    expect(await grants(m)).toEqual({});
    expect(m.calls.after).toEqual([["vidola", null]]);
  });

  it.each([["site"], [null]] as const)("when the window shows %s, not the card: nothing happens", async (view) => {
    const { m, site } = await opened();
    m.setView(view);
    await m.sites.grant("vidola", true, site.request.hash);
    expect(await grants(m)).toEqual({});
    expect(m.calls.after).toEqual([]);
    expect(m.calls.rebroadcast).toEqual([]);
  });

  it("an app that is not open grants nothing", async () => {
    const m = mount();
    m.setView("grant");
    await m.sites.grant("vidola", true, "0".repeat(64));
    expect(await grants(m)).toEqual({});
    expect(m.calls.after).toEqual([]);
  });

  it("accorder during a deletion grants nothing (Review Focus 4)", async () => {
    const { m, site } = await opened();
    let release!: () => void;
    m.keep(new Promise<void>((ok) => (release = ok)));
    const deletion = m.sites.dispatch("vidola", "delete", "f1");
    await vi.waitFor(() => expect(m.log).toContain("fermer vidola"));
    await m.sites.grant("vidola", true, site.request.hash);
    release();
    await deletion;
    expect(await grants(m)).toEqual({});
    expect(m.calls.after).toEqual([]);
  });
});

describe("outils", () => {
  it("lister carries the hash, memoire returns the content, erreurs is empty, an unknown app is null", async () => {
    const m = mount();
    const l = await m.sites.tools.list();
    expect(l.find((s) => s.id === "vidola")!.hash).toMatch(/\S/);
    expect(l.find((s) => s.id === "casse")).toMatchObject({ error: expect.any(String) });
    expect(l.find((s) => s.id === "casse")).not.toHaveProperty("empreinte");
    const mem = await SiteMemory.open(join(m.dataDir, "sites"), "vidola");
    mem.keep("serie", 1, "/s");
    await mem.clear();
    expect((await m.sites.tools.memory("vidola"))!.values).toHaveProperty("serie");
    // Closed: no console. Open: the chrome's.
    m.setErrors([{ when: "q", text: "boum", source: "webaios-tweak://vidola/a.js:1", sourceVerified: false }]);
    expect(await m.sites.tools.errors("vidola")).toEqual([]);
    await m.sites.openById("vidola");
    expect(await m.sites.tools.errors("vidola")).toEqual([{ when: "q", text: "boum", source: "webaios-tweak://vidola/a.js:1", sourceVerified: false }]);
    expect(await m.sites.tools.memory("inconnu")).toBeNull();
    expect(await m.sites.tools.errors("inconnu")).toBeNull();
    expect(await m.sites.tools.open("inconnu")).toBe(false);
  });
});

describe("site rights, card and memory", () => {
  const requested = {
    ...declaration,
    login: ["compte.example"],
    tweaks: [
      { matches: ["/serie/*"], js: ["a.js"], css: ["cacher.css"], frames: ["https://lecteur.example/*"] },
      { matches: ["/serie/*"], js: ["a.js"], css: [], frames: false as const },
    ],
  };

  it("rightsHash follows the rights only", () => {
    const d = DeclarationSite.parse(requested);
    // Rights drift: another sign-in domain changes it; a description does not.
    expect(rightsHash(DeclarationSite.parse({ ...requested, login: ["autre.example"] }))).not.toBe(rightsHash(d));
    expect(rightsHash(DeclarationSite.parse({ ...requested, description: "autre" }))).toBe(rightsHash(d));
  });

  it("grantRequest gives the card (e2e 43): rights, files without duplicates, followed domains, hash", () => {
    const d = DeclarationSite.parse(requested);
    const card = grantRequest({ id: "vidola", declaration: d, hasHome: false, domains: ["vidola-a.example", "VIDOLA-C.example"], start: "https://vidola-a.example/", grantRequired: true });
    expect(card).toEqual({
      name: "Vidola",
      domains: ["vidola-a.example", "vidola-b.example"],
      login: ["compte.example"],
      frames: ["https://lecteur.example/*"],
      resume: true,
      files: ["a.js", "cacher.css"],
      matches: ["/serie/*"],
      tracked: ["vidola-c.example"],
      hash: rightsHash(d),
    });
  });

  it("SchemaActionSite accepts a plain id with a known action only", () => {
    const vs = [{ id: "vidola", action: "delete" }, { id: "../x", action: "delete" }, { id: "Vidola", action: "open" }, { id: "a", action: "autre" }, { id: ".trash", action: "review" }];
    expect(vs.map((v) => SchemaActionSite.safeParse(v).success)).toEqual([true, false, false, false, false]);
  });

  it("SiteRecords has its public methods and writes indented JSON of the whole map", async () => {
    for (const n of ["read", "note", "forget", "clear"]) expect(typeof (SiteRecords.prototype as unknown as Record<string, unknown>)[n]).toBe("function");
    const folder = mkdtempSync(join(tmpdir(), "souvenirs-"));
    cleanup.push(() => rmSync(folder, { recursive: true, force: true }));
    const s = new SiteRecords(folder);
    s.note("vidola", { favicon: "f", frame: { x: 1, y: 2, width: 3, height: 4 } });
    await s.clear();
    expect(readFileSync(join(folder, "sites.json"), "utf8")).toBe(JSON.stringify({ vidola: { favicon: "f", frame: { x: 1, y: 2, width: 3, height: 4 } } }, null, 2));
    expect(readdirSync(folder)).toEqual(["sites.json"]);
  });
});
