import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cheminsEspace, DepotRelecture, depotRelecture, DOSSIER_ESPACE, PORT_MCP_EXTERNE, projetExterne, REMARQUE_VIDE, SANS_CLIENT } from "../../../packages/noyau/src/index";
import { AUCUNE_FENETRE } from "../../navigateur/src/main/design/envoi";
import { createDesignHost, DESIGN_METHODS, elementAffiche, externalMcpPort, lotAffiche, sourceTexte, type DesignHost, type SuiviDesign } from "../noyau/design";
import { INVALID_REQUEST } from "../shared/design-guards";
import { ReviewService } from "../noyau/review";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const c of cleanup.splice(0).reverse()) await c();
});

type Ext = { serveur: { etat: string; port?: number; raison?: string }; projets: { id: string; nom: string }[] };

type App = { dossier: string; nom: string; type: "application" | "poc" | "sans-fiche"; creeLe: string; etat: "arretee" | "en-marche"; port?: number };
const app = (dossier: string, type: App["type"] = "application"): App => ({ dossier, nom: dossier, type, creeLe: "2026-11-07T00:00:00.000Z", etat: "arretee" });

function prepare(o: { port?: number; fenetre?: string | null; sites?: { id: string; nom: string }[]; applis?: App[] } = {}) {
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
  const applis = vi.fn(async () => o.applis ?? []);
  const diffuser = vi.fn();
  const design = createDesignHost({ dataDir, chemins, port: o.port ?? 0, maison, sites, applis, preRemplir, chrome, notifier, diffuser });
  cleanup.push(() => design.arreter());
  return { dataDir, chemins, maison, design, preRemplir, notifier, chrome, sites, applis, diffuser, calls };
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

  it("appsChanged twice within 1 s takes one photo pass, apps without manifest skipped", async () => {
    const spy = vi.spyOn(ReviewService.prototype, "priseEnCharge");
    const s = prepare({ applis: [app("essai"), app("vieux", "sans-fiche"), app("zod", "poc")] });
    // The first takeover, at start.
    await until(() => spy.mock.calls.length, (n) => n === 1);
    expect(spy).toHaveBeenLastCalledWith(["essai", "zod"]);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    s.design.appsChanged();
    vi.advanceTimersByTime(500);
    s.design.appsChanged();
    vi.advanceTimersByTime(999);
    expect(s.applis).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    vi.useRealTimers();
    await until(() => spy.mock.calls.length, (n) => n === 2);
    expect(spy).toHaveBeenLastCalledWith(["essai", "zod"]);
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

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const contexte = (o: Record<string, unknown> = {}) => ({
  selecteur: "#b", etiquette: "button#b", html: "<button id=b>Ok</button>", adresse: "http://127.0.0.1:15283/",
  voisinage: { parent: "main", freres: ["p"] }, styles: { color: "red" }, source: { fichier: "src/A.svelte", ligne: 3 },
  vue: { largeur: 800, hauteur: 600 }, ...o,
});

describe("design host, the carts", { timeout: 20_000 }, () => {
  /** A demo on 15283 (in WEBAIOS_PORTS_APPS), app-essai running on 15281, an external project on 3000. */
  async function withProjects(o: Parameters<typeof prepare>[0] = {}) {
    vi.stubEnv("WEBAIOS_PORTS_APPS", "15280-15284");
    const s = prepare({ applis: [{ ...app("essai"), nom: "Essai", etat: "en-marche", port: 15281 }, app("dort")], sites: [{ id: "x", nom: "Site X" }], ...o });
    const projet = join(s.maison, "projet");
    mkdirSync(projet);
    await callTool(s.design, "declarer_projet", { dossier: projet, ports: [3000], nom: "Projet" });
    const ext = `ext-${(await liste(s.design)).projets[0]!.id}`;
    return { ...s, ext, h: s.design.handlers };
  }
  const suivi = (h: DesignHost["handlers"], p: unknown) => h["design.suivi"]!(p) as Promise<SuiviDesign | null>;

  it("design.suivi of a demo, an app running on its port, an external project's port, and nothing elsewhere", async () => {
    const { h, ext } = await withProjects();
    expect(await suivi(h, { url: "http://127.0.0.1:15283/" })).toEqual({
      projet: { type: "demo", projet: "demo-15283", port: 15283 }, panier: 0, destination: "l'agent", sansDestination: null, nom: "localhost:15283",
    });
    expect(await suivi(h, { url: "http://localhost:15281/a" })).toMatchObject({ projet: { type: "app", projet: "app-essai" }, nom: "Essai" });
    expect(await suivi(h, { url: "http://localhost:3000/" })).toEqual({
      projet: { type: "externe", projet: ext, dossier: expect.any(String), nom: "Projet", client: expect.any(String) },
      panier: 0, destination: "Claude Code (Claude Code)", sansDestination: null, nom: "Projet",
    });
    expect(await suivi(h, { url: "https://exemple.test/" })).toBeNull();
    expect(await suivi(h, { url: "http://localhost:4999/" })).toBeNull();
    await expect(Promise.resolve().then(() => suivi(h, { url: `http://localhost:15283/${"a".repeat(8192)}` }))).rejects.toThrow(INVALID_REQUEST);
    await expect(Promise.resolve().then(() => suivi(h, {}))).rejects.toThrow(INVALID_REQUEST);
  });

  it("design.suivi of app-essai, site-x, demo-15283, an unknown ext- id", async () => {
    const { h } = await withProjects();
    expect(await suivi(h, { projet: "app-essai" })).toMatchObject({ projet: { type: "app", projet: "app-essai", dossier: "essai", nom: "Essai" }, nom: "Essai" });
    // Not running: Electron's applis() lists the running ones, the name falls back to the folder.
    expect(await suivi(h, { projet: "app-dort" })).toMatchObject({ nom: "dort" });
    expect(await suivi(h, { projet: "site-x" })).toMatchObject({ projet: { type: "site", projet: "site-x", id: "x", nom: "Site X" }, destination: "l'agent" });
    expect(await suivi(h, { projet: "site-y" })).toBeNull();
    expect(await suivi(h, { projet: "demo-15283" })).toMatchObject({ projet: { type: "demo", port: 15283 }, nom: "localhost:15283" });
    expect(await suivi(h, { projet: "ext-0123456789abcdef" })).toBeNull();
    await expect(Promise.resolve().then(() => suivi(h, { projet: "../x" }))).rejects.toThrow("projet invalide");
  });

  it("ajouter puts the remark and its PNG in the cart; a blank text gives REMARQUE_VIDE; 4001 characters, a non-PNG capture or a bad context give INVALID_REQUEST, nothing written", async () => {
    const { h, chemins } = await withProjects();
    const dossier = join(chemins.interne, "remarques", "demo-15283");
    const add = (o: Record<string, unknown>) => h["design.ajouter"]!({ projet: "demo-15283", texte: "Plus grand", contexte: contexte(), capture: PNG.toString("base64"), ...o });
    const refused = [
      { texte: "a".repeat(4001) },
      { texte: 3 },
      { capture: Buffer.from("GIF89a").toString("base64") },
      { capture: 7 },
      { contexte: contexte({ html: "a".repeat(5000) }) },
      { contexte: contexte({ vue: { largeur: Number.NaN, hauteur: 1 } }) },
      { contexte: contexte({ styles: { color: 1 } }) },
      { contexte: null },
      { projet: "../x" },
      { projet: "ext-0123456789abcdef" },
    ];
    for (const r of refused) expect(await add(r), JSON.stringify(r).slice(0, 80)).toEqual({ ok: false, erreur: INVALID_REQUEST });
    expect(await add({ texte: "  \n" })).toEqual({ ok: false, erreur: REMARQUE_VIDE });
    expect(existsSync(dossier)).toBe(false);

    expect(await add({ texte: "a".repeat(4000), contexte: contexte({ extra: "x", source: null }) })).toEqual({ ok: true });
    expect(await add({ capture: null, contexte: contexte({ source: { fichier: "src/A.svelte", ligne: 3, colonne: 0 } }) })).toEqual({ ok: true });
    const panier = (await h["design.panier"]!({ projet: "demo-15283" })) as { id: string; texte: string; source: string | null }[];
    expect(panier.map((e) => [e.texte.length, e.source])).toEqual([[4000, null], [10, "src/A.svelte:3"]]);
    expect(readFileSync(join(dossier, `${panier[0]!.id}.png`))).toEqual(PNG);
    expect(existsSync(join(dossier, `${panier[1]!.id}.png`))).toBe(false);
    // Only known keys are written.
    expect(readFileSync(join(dossier, "panier.json"), "utf8")).not.toContain("extra");
    expect(await suivi(h, { projet: "demo-15283" })).toMatchObject({ panier: 2 });
  });

  it("envoyer of a demo writes the lot under the space and asks the agent's window; of an external project without client gives SANS_CLIENT", async () => {
    const { h, chemins, chrome, calls, ext, design, dataDir } = await withProjects();
    await h["design.ajouter"]!({ projet: "demo-15283", texte: "Plus grand", contexte: contexte(), capture: null });
    expect(await h["design.envoyer"]!({ projet: "demo-15283" })).toEqual({ ok: true });
    const dossier = join(chemins.interne, "remarques", "demo-15283");
    expect(readdirSync(dossier).filter((n) => existsSync(join(dossier, n, "lot.json")))).toHaveLength(1);
    expect(chrome.fenetreAgent).toHaveBeenCalled();
    expect(calls).toEqual([expect.stringMatching(/^preRemplir f7 /), "donnerAgent f7"]);
    expect(await h["design.panier"]!({ projet: "demo-15283" })).toEqual([]);
    expect(await h["design.lots"]!({ projet: "demo-15283" })).toMatchObject([{ etat: "en-attente", destination: "agent", elements: [{ texte: "Plus grand" }] }]);

    // The client revoked: no destination.
    const client = ((await liste(design)).projets[0] as unknown as { client: string }).client;
    await h["externes.revoquer"]!({ id: client });
    await h["design.ajouter"]!({ projet: ext, texte: "x", contexte: contexte(), capture: null });
    chrome.fenetreAgent.mockClear();
    expect(await h["design.envoyer"]!({ projet: ext })).toEqual({ ok: false, erreur: SANS_CLIENT });
    expect(await h["design.envoyer"]!({ projet: "ext-0123456789abcdef" })).toEqual({ ok: false, erreur: SANS_CLIENT });
    expect(await h["design.envoyer"]!({ projet: "../x" })).toEqual({ ok: false, erreur: INVALID_REQUEST });
    expect(chrome.fenetreAgent).not.toHaveBeenCalled();
    // An external project's cart stays under <dataDir>/design, never in the space.
    expect(existsSync(join(chemins.interne, "remarques", ext))).toBe(false);
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
    expect(walk(join(dataDir, "design")).some((f) => f.includes(ext) && f.endsWith("panier.json"))).toBe(true);
  });

  it("traite marks the lot; an id of 65 characters does nothing", async () => {
    const { h } = await withProjects();
    await h["design.ajouter"]!({ projet: "demo-15283", texte: "a", contexte: contexte(), capture: null });
    await h["design.ajouter"]!({ projet: "demo-15283", texte: "b", contexte: contexte(), capture: null });
    const [a] = (await h["design.panier"]!({ projet: "demo-15283" })) as { id: string }[];
    expect(await h["design.retirer"]!({ projet: "demo-15283", id: "x".repeat(65) })).toBeUndefined();
    expect(await h["design.retirer"]!({ projet: "demo-15283", id: 3 })).toBeUndefined();
    await h["design.retirer"]!({ projet: "demo-15283", id: a!.id });
    expect(((await h["design.panier"]!({ projet: "demo-15283" })) as { texte: string }[]).map((e) => e.texte)).toEqual(["b"]);
    await h["design.envoyer"]!({ projet: "demo-15283" });
    const [lot] = (await h["design.lots"]!({ projet: "demo-15283" })) as { id: string; etat: string }[];
    expect(await h["design.traite"]!({ projet: "demo-15283", lot: `${lot!.id}${"0".repeat(65 - lot!.id.length)}` })).toBeUndefined();
    expect(await h["design.lots"]!({ projet: "demo-15283" })).toMatchObject([{ etat: "en-attente" }]);
    await h["design.traite"]!({ projet: "demo-15283", lot: lot!.id });
    expect(await h["design.lots"]!({ projet: "demo-15283" })).toMatchObject([{ etat: "traite" }]);
    // A bad project answers as ipc.ts: an empty list, or nothing.
    for (const projet of ["../x", 3, undefined]) {
      expect(await h["design.panier"]!({ projet })).toEqual([]);
      expect(await h["design.lots"]!({ projet })).toEqual([]);
      expect(await h["design.retirer"]!({ projet, id: "e-00000000" })).toBeUndefined();
      expect(await h["design.traite"]!({ projet, lot: lot!.id })).toBeUndefined();
    }
    expect(await h["design.panier"]!(null)).toEqual([]);
  });

  it("drift: elementAffiche, lotAffiche and sourceTexte are service.ts's word for word", () => {
    const service = readFileSync(new URL("../../navigateur/src/main/design/service.ts", import.meta.url), "utf8");
    const design = readFileSync(new URL("../noyau/design.ts", import.meta.url), "utf8");
    for (const name of ["sourceTexte", "elementAffiche", "lotAffiche"]) {
      const body = new RegExp(`function ${name}\\([^]*?\\n}\\n`).exec(design)?.[0];
      expect(body, name).toBeTruthy();
      expect(service).toContain(body!);
    }
    expect(sourceTexte({ fichier: "a", ligne: 2 })).toBe("a:2");
    expect(lotAffiche).toBeTypeOf("function");
    expect(elementAffiche).toBeTypeOf("function");
  });
});
