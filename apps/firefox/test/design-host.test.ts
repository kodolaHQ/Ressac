import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cheminsEspace, DepotRelecture, depotRelecture, DOSSIER_ESPACE, PORT_MCP_EXTERNE, projetExterne } from "../../../packages/noyau/src/index";
import { AUCUNE_FENETRE } from "../../navigateur/src/main/design/envoi";
import { createDesignHost, DESIGN_METHODS, externalMcpPort, type DesignHost } from "../noyau/design";
import { ReviewService } from "../noyau/review";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const c of cleanup.splice(0).reverse()) await c();
});

type Ext = { serveur: { etat: string; port?: number; raison?: string }; projets: { id: string; nom: string }[] };

function prepare(o: { port?: number; fenetre?: string | null; sites?: { id: string; nom: string }[] } = {}) {
  const dataDir = realpathSync(mkdtempSync(join(tmpdir(), "webaios-design-")));
  cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }));
  const chemins = cheminsEspace(join(dataDir, "espace"));
  mkdirSync(chemins.sites, { recursive: true });
  // Outside <dataDir>: a project under it would be refused.
  const maison = realpathSync(mkdtempSync(join(tmpdir(), "webaios-maison-")));
  cleanup.push(() => rmSync(maison, { recursive: true, force: true }));
  const calls: string[] = [];
  const preRemplir = vi.fn((f: string, t: string) => void calls.push(`preRemplir ${f} ${t}`));
  const notifier = vi.fn();
  const chrome = {
    fenetreAgent: vi.fn(async () => (o.fenetre === undefined ? "f7" : o.fenetre)),
    donnerAgent: vi.fn((f: string) => void calls.push(`donnerAgent ${f}`)),
  };
  const sites = vi.fn(async () => o.sites ?? []);
  const diffuser = vi.fn();
  const design = createDesignHost({ dataDir, chemins, port: o.port ?? 0, maison, sites, preRemplir, chrome, notifier, diffuser });
  cleanup.push(() => design.arreter());
  return { dataDir, chemins, maison, design, preRemplir, notifier, chrome, sites, diffuser, calls };
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

const liste = (d: DesignHost) => d.handlers["externes.liste"]!(undefined) as Promise<Ext>;
const ready = (d: DesignHost) => until(() => liste(d), (e) => e.serveur.etat !== "eteint" || e.serveur.raison !== "Le MCP externe démarre");

/** Connects a real MCP client with the token of « Brancher » and calls a tool, like a Claude Code would. */
async function callTool(d: DesignHost, nom: string, args: Record<string, unknown>) {
  const { serveur } = await ready(d);
  const { commande } = (await d.handlers["externes.brancher"]!({ nom: "Claude Code" })) as { commande: string };
  const jeton = /Bearer (\S+)"/.exec(commande)![1]!;
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const client = new Client({ name: "test", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${serveur.port}/mcp-externe`), { requestInit: { headers: { Authorization: `Bearer ${jeton}` } } }),
  );
  try {
    const r = (await client.callTool({ name: nom, arguments: args })) as { content: { text?: string }[]; isError?: boolean };
    return { texte: r.content.map((c) => c.text ?? "").join("\n"), erreur: r.isError === true };
  } finally {
    await client.close();
  }
}

/** A site app « tuning » with a changed file and one comment on it, ready for relecture.envoyer. */
async function siteWithComment(s: ReturnType<typeof prepare>) {
  const dossier = join(s.chemins.sites, "tuning");
  mkdirSync(dossier, { recursive: true });
  writeFileSync(join(dossier, "a.txt"), "un\n");
  const h = s.design.handlers;
  await h["relecture.ouvrir"]!({ projet: "site-tuning", jeton: null });
  writeFileSync(join(dossier, "a.txt"), "deux\n");
  const v = (await h["relecture.ouvrir"]!({ projet: "site-tuning" })) as { etat: string; jeton: string };
  expect(v.etat).toBe("ok");
  expect(await h["relecture.commenter"]!({ projet: "site-tuning", jeton: v.jeton, c: { fichier: "a.txt", debut: 1, fin: 1, texte: "Plus\r\nclair" } })).toEqual({ ok: true });
}

describe("design host", { timeout: 20_000 }, () => {
  it("externalMcpPort: 5279 by default, NaN for a bad value", () => {
    expect(externalMcpPort(undefined)).toBe(5279);
    expect(PORT_MCP_EXTERNE).toBe(5279);
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
    await s.design.handlers["externes.brancher"]!({ nom: "Claude Code" });
    const fichier = join(s.dataDir, "design", "clients-externes.json");
    expect(statSync(fichier).mode & 0o777).toBe(0o600);
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [e.name]));
    expect(walk(join(s.dataDir, "espace")).filter((n) => n.includes("externes"))).toEqual([]);
  });

  it("declaring <dataDir>, <dataDir>/design/x or <dataDir>/espace/projets/x is refused with DOSSIER_ESPACE", async () => {
    const s = prepare();
    const dossiers = [s.dataDir, join(s.dataDir, "design", "x"), join(s.chemins.projets, "x")];
    for (const d of dossiers.slice(1)) mkdirSync(d, { recursive: true });
    for (const dossier of dossiers) {
      const r = await callTool(s.design, "declarer_projet", { dossier, ports: [3000] });
      expect(r.texte).toContain(DOSSIER_ESPACE);
    }
    expect((await liste(s.design)).projets).toEqual([]);
  });

  // Review Focus 2
  it("a folder that links into <dataDir> is refused with DOSSIER_ESPACE", async () => {
    const s = prepare();
    mkdirSync(join(s.dataDir, "design"), { recursive: true });
    const dehors = realpathSync(mkdtempSync(join(tmpdir(), "webaios-lien-")));
    cleanup.push(() => rmSync(dehors, { recursive: true, force: true }));
    const lien = join(dehors, "lien");
    symlinkSync(join(s.dataDir, "design"), lien);
    const r = await callTool(s.design, "declarer_projet", { dossier: lien, ports: [3000] });
    expect(r.texte).toContain(DOSSIER_ESPACE);
    expect((await liste(s.design)).projets).toEqual([]);
    expect(existsSync(join(s.dataDir, "design", "projets-externes.json"))).toBe(false);
    expect(existsSync(join(s.dataDir, "design", "relecture"))).toBe(false);
  });

  it("a first declaration notifies once", async () => {
    const s = prepare();
    const projet = join(s.maison, "projet");
    mkdirSync(projet);
    await callTool(s.design, "declarer_projet", { dossier: projet, ports: [3000], nom: "Projet" });
    await callTool(s.design, "declarer_projet", { dossier: projet, ports: [3001] });
    expect(s.notifier).toHaveBeenCalledTimes(1);
    expect(s.notifier).toHaveBeenCalledWith({ titre: "WebAiOs", texte: "Claude Code a branché le projet Projet" });
    const e = await liste(s.design);
    expect(e.projets.map((p) => p.nom)).toEqual(["Projet"]);
    expect(await s.design.handlers["externes.nom"]!({ id: e.projets[0]!.id })).toBe("Projet");
    expect(await s.design.handlers["externes.nom"]!({ id: "0123456789abcdef" })).toBeNull();
  });

  // Electron envoi.test.ts:34
  it("a batch reaches the window fenetreAgent gives, without \\r, then donnerAgent; an external project asks nothing of the chrome", async () => {
    const s = prepare({ sites: [{ id: "tuning", nom: "Tuning" }] });
    await siteWithComment(s);
    expect(await s.design.handlers["relecture.envoyer"]!({ projet: "site-tuning" })).toEqual({ ok: true });
    expect(s.calls).toHaveLength(2);
    expect(s.calls[0]).toMatch(/^preRemplir f7 /);
    expect(s.calls[0]!.slice("preRemplir f7 ".length)).not.toMatch(/\r/);
    expect(s.calls[1]).toBe("donnerAgent f7");

    // An external project: its batch is in the MCP queue, the chrome is never asked.
    const projet = join(s.maison, "projet");
    mkdirSync(projet);
    writeFileSync(join(projet, "a.txt"), "un\n");
    await callTool(s.design, "declarer_projet", { dossier: projet, ports: [3000] });
    const id = `ext-${(await liste(s.design)).projets[0]!.id}`;
    const h = s.design.handlers;
    await until(() => h["relecture.ouvrir"]!({ projet: id }) as Promise<{ etat: string }>, (v) => v.etat === "ok");
    writeFileSync(join(projet, "a.txt"), "deux\n");
    const v = (await h["relecture.ouvrir"]!({ projet: id })) as { jeton: string };
    await h["relecture.commenter"]!({ projet: id, jeton: v.jeton, c: { fichier: "a.txt", debut: 1, fin: 1, texte: "x" } });
    s.chrome.fenetreAgent.mockClear();
    expect(await h["relecture.envoyer"]!({ projet: id })).toEqual({ ok: true });
    expect(s.chrome.fenetreAgent).not.toHaveBeenCalled();
    expect(s.calls).toHaveLength(2);
  });

  // Electron envoi.test.ts:51
  it("fenetreAgent gives null: AUCUNE_FENETRE, and the batch stays written", async () => {
    const s = prepare({ fenetre: null, sites: [{ id: "tuning", nom: "Tuning" }] });
    await siteWithComment(s);
    expect(await s.design.handlers["relecture.envoyer"]!({ projet: "site-tuning" })).toEqual({ ok: false, erreur: AUCUNE_FENETRE });
    expect(s.preRemplir).not.toHaveBeenCalled();
    expect(readdirSync(join(s.chemins.interne, "remarques", "site-tuning")).filter((n) => existsSync(join(s.chemins.interne, "remarques", "site-tuning", n, "lot.json")))).toHaveLength(1);
  });

  // Electron envoi.test.ts:66
  it("a site: the app, its folder and the batch path, without \\r or \\n", async () => {
    const s = prepare({ sites: [{ id: "tuning", nom: "Tuning" }] });
    await siteWithComment(s);
    await s.design.handlers["relecture.envoyer"]!({ projet: "site-tuning" });
    const [f, texte] = s.preRemplir.mock.calls[0]!;
    expect(f).toBe("f7");
    expect(texte).toContain('appli de site "Tuning" (/workspace/sites/tuning/)');
    expect(texte).toMatch(/\/workspace\/\.webaios\/remarques\/site-tuning\/[^/]+\/lot\.json\] /);
    expect(texte).not.toMatch(/[\r\n]/);
    expect(s.chrome.donnerAgent).toHaveBeenCalledWith("f7");
  });

  // Electron externes.test.ts:29
  it("a start that fails otherwise than a held port (bad port): off, with the reason", async () => {
    const s = prepare({ port: externalMcpPort("abc") });
    const e = await ready(s.design);
    expect(e.serveur.etat).toBe("eteint");
    expect(e.serveur.raison).toMatch(/^Le MCP externe n'a pas pu démarrer : /);
    await expect(s.design.handlers["externes.brancher"]!({ nom: "x" })).rejects.toThrow(/n'a pas pu démarrer/);
  });

  // Electron externes.test.ts:37
  it("forgetting during the first snapshot: the private review repository does not come back", async () => {
    const s = prepare();
    await ready(s.design);
    const projet = join(s.maison, "site");
    mkdirSync(projet);
    for (let i = 0; i < 50; i++) writeFileSync(join(projet, `f${i}.txt`), `${i}\n`);
    const id = "0123456789abcdef";
    const dossiers = { remarquesEspace: join(s.chemins.interne, "remarques"), prive: join(s.dataDir, "design") };
    const depot = depotRelecture(dossiers, projetExterne(id));
    const photo = new DepotRelecture({ depot, dossier: projet }).assurerReference().catch(() => undefined);
    await s.design.handlers["externes.oublier"]!({ id });
    await photo;
    expect(existsSync(depot)).toBe(false);
  });

  it("sitesChanged twice within 1 s takes one photo pass", async () => {
    const spy = vi.spyOn(ReviewService.prototype, "priseEnChargeSites");
    const s = prepare({ sites: [{ id: "tuning", nom: "Tuning" }] });
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

  it("siteDeleted erases site-<id>.git, its comments and its lots", async () => {
    const s = prepare({ sites: [{ id: "tuning", nom: "Tuning" }] });
    await siteWithComment(s);
    await s.design.handlers["relecture.envoyer"]!({ projet: "site-tuning" });
    const relecture = join(s.dataDir, "design", "relecture");
    const lots = join(s.chemins.interne, "remarques", "site-tuning");
    expect(existsSync(join(relecture, "site-tuning.git"))).toBe(true);
    expect(existsSync(join(relecture, "site-tuning.commentaires.json"))).toBe(true);
    expect(existsSync(lots)).toBe(true);
    rmSync(join(s.chemins.sites, "tuning"), { recursive: true });
    s.design.siteDeleted("tuning");
    await until(() => [join(relecture, "site-tuning.git"), join(relecture, "site-tuning.commentaires.json"), lots].some(existsSync), (v) => !v);
  });

  it("bad inputs are refused with Electron's messages before the service", async () => {
    const s = prepare();
    const spy = vi.spyOn(ReviewService.prototype, "fichier");
    const h = s.design.handlers;
    const jeton = `${"a".repeat(40)}:${"b".repeat(40)}`;
    expect(() => h["relecture.fichier"]!({ projet: "site-tuning", jeton, chemin: "../x\0" })).toThrow("chemin invalide");
    expect(() => h["relecture.fichier"]!({ projet: "site-tuning", jeton: "a".repeat(39), chemin: "a.txt" })).toThrow("jeton invalide");
    expect(() => h["relecture.fichier"]!({ projet: "../x", jeton, chemin: "a.txt" })).toThrow("projet invalide");
    expect(() => h["relecture.lignes"]!({ projet: "site-tuning", jeton, chemin: "a.txt", debut: 3, fin: 2 })).toThrow("lignes invalides");
    expect(() => h["relecture.commenter"]!({ projet: "site-tuning", jeton, c: null })).toThrow("lignes invalides");
    expect(() => h["relecture.resoudre"]!({ projet: "site-tuning", id: "c-00000001", resolu: "oui" })).toThrow("résolu invalide");
    expect(() => h["relecture.supprimerCommentaire"]!({ projet: "site-tuning", id: "x" })).toThrow("commentaire invalide");
    expect(() => h["relecture.modifierCommentaire"]!({ projet: "site-tuning", id: "c-00000001", texte: "x".repeat(4001) })).toThrow("texte invalide");
    expect(spy).not.toHaveBeenCalled();
    await expect(Promise.resolve().then(() => h["externes.brancher"]!({ nom: "x".repeat(201) }))).rejects.toThrow("Nom invalide");
    // A bad id does nothing, as ipc.ts.
    await ready(s.design);
    expect(await h["externes.revoquer"]!({ id: "../x" })).toBeUndefined();
    expect(await h["externes.oublier"]!({ id: "zz" })).toBeUndefined();
  });
});
