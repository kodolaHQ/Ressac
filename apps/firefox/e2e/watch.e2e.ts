import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { newWindow, state, waitReady } from "./firefox";
import { launchWebAiOs, type LaunchedWebAiOs } from "./launch";
import type { Marionette } from "./marionette";
import { click, inUi } from "./ui";
import { writeWidget } from "./workflows";

// The watch end to end: all local. An ad site, a fake DuckDuckGo (the kernel tests'
// saved pages), a fake Kev and a fake Ollama. No real notification: test mode writes them to a file in the data folder.
// Plus the click on a notification.

const FIXTURES_DDG = path.resolve(import.meta.dirname, "../../../packages/noyau/test/workflows/fixtures/duckduckgo");
/** The kernel's exact message (accueil/schemas.ts, WEB_AVEC_COMPTE). */
const WEB_WITH_ACCOUNT = "web : impossible avec un compte (les données d'un compte ne doivent pas pouvoir partir vers un site inconnu)";

interface Server {
  url: string;
  /** Paths received, in order. */
  log: string[];
  close(): Promise<void>;
}

async function listen(handle: (req: IncomingMessage, res: ServerResponse, body: string) => void): Promise<Server> {
  const log: string[] = [];
  const server = createServer((req, res) => {
    log.push(req.url ?? "/");
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => handle(req, res, body));
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    log,
    close: () => new Promise((ok) => (server.closeAllConnections(), server.close(() => ok()))),
  };
}

const html = (res: ServerResponse, body: string) => res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(body);

/** Five ads of two models: three Clio 4, two 208. */
const ADS = [
  { n: 1, titre: "Renault Clio 4 – 6 500 €" },
  { n: 2, titre: "Peugeot 208 – 7 200 €" },
  { n: 3, titre: "Renault Clio 4 – 5 900 €" },
  { n: 4, titre: "Peugeot 208 – 6 800 €" },
  { n: 5, titre: "Renault Clio 4 – 7 900 €" },
];

/** The site's and fake servers' settings, reset before each test (the tests of a file run one after the other). */
const settings = {
  /** Ad pages (n) whose read fails (connection cut). */
  failingPages: new Set<number>(),
  /** The file the fake DuckDuckGo serves. */
  ddg: "resultats.html",
  /** The fake Gemma's answer delay. */
  gemmaDelayMs: 0,
};

let site: Server;
let kev: Server;
let ollama: Server & { prompts: string[] };

beforeAll(async () => {
  site = await listen((req, res) => {
    const p = new URL(req.url ?? "/", "http://x").pathname;
    if (p === "/recherche")
      return html(
        res,
        `<title>Annonces</title><h1>Voitures d'occasion</h1><ul>${ADS.map((a) => `<li><a href="/annonce/${a.n}">${a.titre}</a></li>`).join("")}</ul><a href="/aide">Aide</a>`,
      );
    const ad = /^\/annonce\/(\d+)$/.exec(p);
    if (ad) {
      const n = Number(ad[1]);
      if (settings.failingPages.has(n)) return void req.socket.destroy();
      const a = ADS.find((x) => x.n === n);
      return html(res, `<title>Annonce ${n}</title><p>${a?.titre ?? "?"}, première main, 82 000 km, carnet d'entretien.</p>`);
    }
    if (p === "/ddg/") return html(res, readFileSync(path.join(FIXTURES_DDG, settings.ddg), "utf8"));
    if (p === "/court") return html(res, "<title>Court</title>");
    res.writeHead(404).end();
  });
  // Fake Kev: every ad matches the criteria.
  kev = await listen((req, res) => {
    if (req.method === "GET") return void res.writeHead(200, { "Content-Type": "application/json" }).end('{"data":[]}');
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ answers: { q: { noul: 0.9 } } }));
  });
  // Fake Ollama: Gemma gives a short opinion (after `gemmaDelayMs`) and logs each prompt.
  const prompts: string[] = [];
  const ollamaServer = await listen((req, res, body) => {
    if (req.url !== "/api/chat") return void res.writeHead(200, { "Content-Type": "application/json" }).end('{"models":[]}');
    prompts.push(String((JSON.parse(body) as { messages: { content: string }[] }).messages[0]?.content));
    setTimeout(
      () => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ message: { content: "Bonne affaire." } })),
      settings.gemmaDelayMs,
    );
  });
  ollama = Object.assign(ollamaServer, { prompts });
});
afterAll(async () => {
  await Promise.all([site, kev, ollama].map((s) => s?.close()));
});

let dataDir: string;
/** The apps launched by the test, closed after it. */
let launched: LaunchedWebAiOs[] = [];
beforeEach(async () => {
  settings.failingPages.clear();
  settings.ddg = "resultats.html";
  settings.gemmaDelayMs = 0;
  dataDir = await mkdtemp(path.join(os.tmpdir(), "webaios-watch-"));
});
afterEach(async () => {
  await Promise.all(launched.map((l) => l.close()));
  launched = [];
  await rm(dataDir, { recursive: true, force: true });
});

const notificationsFile = () => path.join(dataDir, "notifications.jsonl");
/** Notifications written by the app, in order. */
const notifications = (): { titre: string; texte: string }[] =>
  existsSync(notificationsFile()) ? readFileSync(notificationsFile(), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];

/** Launches on `dataDir` (kept), tall enough for every widget to show; waits for the home page. */
async function launchWatch(): Promise<Marionette> {
  const l = await launchWebAiOs({
    dataDir,
    height: 1400,
    env: {
      WEBAIOS_KEV_URL: kev.url,
      WEBAIOS_OLLAMA_URL: ollama.url,
      WEBAIOS_TEST_ADRESSES_LOCALES: "1",
      WEBAIOS_TEST_DUCKDUCKGO_URL: `${site.url}/ddg/`,
      WEBAIOS_TEST_NOTIFICATIONS: notificationsFile(),
    },
  });
  launched.push(l);
  const m = l.marionette;
  await m.setContext("chrome");
  await waitReady(m);
  return m;
}

/** The ads' extraction from the search page (the `annonces.mjs` the agent would write). */
const ANNOUNCEMENTS_MJS = `export default async (page) => {
  const annonces = [];
  for (const l of page.liens) {
    if (!l.url.includes("/annonce/")) continue;
    const [nom, prix] = l.texte.split(" – ");
    const [marque, ...reste] = nom.split(" ");
    const modele = reste.join(" ");
    annonces.push({ titre: l.texte, url: l.url, prix, marque, modele, ...(marque && modele ? { modeleComplet: marque + " " + modele } : {}) });
  }
  if (annonces.length === 0) throw new Error("Aucune annonce trouvée : Leboncoin a peut-être bloqué la lecture");
  return annonces;
};
`;

/** The watch widget, after AGENTS.md's commented example (used cars), with a state « hour of the day done ». */
async function writeWatch(): Promise<void> {
  await writeWidget(dataDir, "voitures", {
    nom: "Veille voitures",
    recolte: { heures: ["07:00"], dureeMaxMinutes: 30, notifier: true },
    declaration: {
      tailles: { min: { l: 3, h: 3 }, max: { l: 12, h: 8 }, defaut: { l: 6, h: 5 } },
      sources: { compte: [], publiques: [], web: true },
      config: { recherche: `${site.url}/recherche`, criteres: "citadine fiable, moins de 100 000 km, moins de 8 000 €" },
    },
    workflow: {
      version: 1,
      blocs: [
        { id: "recherche", type: "source.page", parametres: { url: "{config.recherche}" } },
        { id: "annonces", type: "code", parametres: { source: "annonces.mjs" } },
        { id: "nouvelles", type: "liste.nouveaux", parametres: { cle: "url", garderJours: 30 } },
        { id: "tri", type: "ia.trier", parametres: { question: "Cette annonce correspond-elle à : {config.criteres} ?", texte: "{titre}" } },
        { id: "top", type: "liste.garder", parametres: { nombre: 10 } },
        { id: "fiche", type: "source.page", parametres: { url: "{url}", parElement: true, champ: "fiche" } },
        {
          id: "fiabilite",
          type: "web.chercher",
          parametres: { requete: "fiabilité {marque} {modele}", parElement: true, champ: "fiabilite", reutiliser: "modeleComplet", garderJours: 30 },
        },
        {
          id: "avis",
          type: "ia.rediger",
          parametres: {
            parElement: true,
            champ: "avis",
            consigne:
              "Donne en trois phrases l'intérêt de cette annonce pour : {config.criteres}. Si l'annonce est une page de vérification ou ne décrit pas une voiture, ne réponds rien. Si aucun résultat de recherche n'est donné, juge sans. --- DÉBUT DE L'ANNONCE --- {fiche.texte} --- FIN DE L'ANNONCE --- --- DÉBUT DES RÉSULTATS DE RECHERCHE --- {fiabilite?} --- FIN DES RÉSULTATS DE RECHERCHE ---",
          },
        },
        { id: "sortie", type: "sortie", parametres: { vers: "widget", auFilDeLEau: true } },
      ],
      liens: [
        { de: "recherche", vers: "annonces" },
        { de: "annonces", vers: "nouvelles" },
        { de: "nouvelles", vers: "tri" },
        { de: "tri", vers: "top" },
        { de: "top", vers: "fiche" },
        { de: "fiche", vers: "fiabilite" },
        { de: "fiabilite", vers: "avis" },
        { de: "avis", vers: "sortie" },
      ],
    },
    fichiers: { "annonces.mjs": ANNOUNCEMENTS_MJS, "exemple.json": "[]" },
  });
  // « Up to date, hour of the day done »: no run starts by itself during the test.
  const now = new Date().toISOString();
  await writeJson(path.join(dataDir, "widgets", "voitures", "etat.json"), {
    statut: "ok",
    derniereMaj: now,
    derniereTentative: now,
    heures: { faite: "9999-12-31T23:59", echecs: null },
  });
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value));
}
const readJson = (file: string) => JSON.parse(readFileSync(file, "utf8"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Polls `read` until `ok` accepts it; fails with the last value after `ms`. */
async function until<T>(read: () => T | Promise<T>, ok: (v: T) => boolean, ms = 10_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    let v: T | undefined;
    try {
      v = await read();
      if (ok(v)) return v;
    } catch {}
    if (Date.now() > deadline) throw new Error(`timed out: last ${JSON.stringify(v)}`);
    await sleep(100);
  }
}
const untilEqual = <T>(read: () => T | Promise<T>, expected: T, ms?: number) => until(read, (v) => JSON.stringify(v) === JSON.stringify(expected), ms);

/** The `#donnees` text of the widget's display (opaque origin: read from the chrome context). */
const shown = (m: Marionette, id: string) =>
  inUi<string>(m, `return doc.querySelector('[data-testid="widget-' + arguments[0] + '"] iframe')?.contentDocument?.getElementById("donnees")?.textContent ?? "";`, [id]);
/** The widget's « mise à jour… n / t » badge, or null. */
const progress = (m: Marionette, id: string) =>
  inUi<string | null>(m, `return doc.querySelector('[data-testid="widget-' + arguments[0] + '"] [data-testid="progression"]')?.textContent ?? null;`, [id]);
const widgetText = (m: Marionette, id: string) => inUi<string>(m, `return doc.querySelector('[data-testid="widget-' + arguments[0] + '"]')?.textContent ?? "";`, [id]);

/** « Mettre à jour maintenant » from the widget's menu. */
async function harvest(m: Marionette, id: string): Promise<void> {
  await click(m, `[data-testid="widget-${id}"] button[aria-label="Options du widget"]`);
  await click(m, '[role="menuitem"]', { text: "Mettre à jour maintenant" });
}

type Ad = { titre: string; url: string; marque: string; modele: string; fiche?: { texte: string }; fiabilite?: unknown[]; avis?: string };
const watchData = (): Ad[] | null => {
  const f = path.join(dataDir, "widgets", "voitures", "donnees.json");
  return existsSync(f) ? readJson(f) : null;
};

type Run = { statut: string; declencheur: string; blocs: { id: string; statut: string; journal: string[] }[] };
/** The widget's runs, oldest first. */
const runs = (id = "voitures"): Run[] => {
  const dir = path.join(dataDir, "widgets", id, "executions");
  if (!existsSync(dir)) return [];
  // A temporary file (`.tmp`) may be renamed between the listing and the read: only finished files count, and a file
  // gone meanwhile is skipped.
  return readdirSync(dir)
    .filter((f) => !f.endsWith(".tmp"))
    .sort()
    .flatMap((f) => {
      try {
        return [readJson(path.join(dir, f)) as Run];
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw e;
      }
    });
};
const blockStatus = (e: Run, id: string) => e.blocs.find((b) => b.id === id)?.statut;
const adUrl = (n: number) => `${site.url}/annonce/${n}`;

/** Requests the fake DuckDuckGo got since index `from` of the site's log. */
const searches = (from: number) => site.log.slice(from).filter((c) => c.startsWith("/ddg/"));
const adReads = (from: number) => site.log.slice(from).filter((c) => c.startsWith("/annonce/"));

/** A manual run of the watch, waited for until its end (one more run written). */
async function runWatch(m: Marionette): Promise<Run> {
  const before = runs().length;
  await harvest(m, "voitures");
  await until(() => runs().length, (n) => n === before + 1, 60_000);
  return runs().at(-1)!;
}

const NOTIFICATION = { titre: "Veille voitures", texte: "5 nouveaux éléments" };

// ---------------------------------------------------------------------------------------------------------------------

it("watch end to end: the widget fills in as it goes (counter seen), a search by model, a « 5 nouveaux éléments » notification", async () => {
  // A slow Gemma: the ads finish one after the other, the progress and the publications show.
  settings.gemmaDelayMs = 2500;
  await writeWatch();
  const from = site.log.length;
  const m = await launchWatch();
  await untilEqual(() => shown(m, "voitures"), "[]");

  await harvest(m, "voitures");
  // The counter, then part of the ads in the widget before the end.
  await until(() => progress(m, "voitures"), (t) => /^mise à jour… [1-4] \/ 5$/.test(t ?? ""), 60_000);
  await until(
    () => shown(m, "voitures"),
    (t) => {
      const n = t.startsWith("[") ? (JSON.parse(t) as unknown[]).length : -1;
      return n >= 1 && n < 5;
    },
    30_000,
  );
  // Then all, with their page, reliability and opinion.
  await until(() => runs().length, (n) => n === 1, 60_000);
  expect(runs()[0]!.statut).toBe("reussie");
  const ads = watchData()!;
  expect(ads.map((a) => a.url).sort()).toEqual([1, 2, 3, 4, 5].map(adUrl).sort());
  for (const a of ads) {
    expect(a.fiche?.texte).toContain("première main");
    expect(a.fiabilite?.length).toBeGreaterThan(0);
    expect(a.avis).toBe("Bonne affaire.");
  }
  await untilEqual(() => progress(m, "voitures"), null);
  await until(() => shown(m, "voitures"), (t) => t.includes("Bonne affaire."));
  // One search per model (three Clio 4, two 208), one read per ad.
  expect(searches(from).map((c) => decodeURIComponent(c.slice(c.indexOf("?q=") + 3)).replace(/\+/g, " ")).sort()).toEqual([
    "fiabilité Peugeot 208",
    "fiabilité Renault Clio 4",
  ]);
  expect(adReads(from).sort()).toEqual([1, 2, 3, 4, 5].map((n) => `/annonce/${n}`));
  // The notification: the widget's name, the number of items, nothing else.
  await untilEqual(notifications, [NOTIFICATION]);
}, 120_000);

it("second run: no already-seen listing, no search for an already studied model, no notification", async () => {
  await writeWatch();
  const m = await launchWatch();
  expect((await runWatch(m)).statut).toBe("reussie");
  expect(watchData()).toHaveLength(5);
  await until(notifications, (n) => n.length === 1);

  const from = site.log.length;
  const promptsBefore = ollama.prompts.length;
  const second = await runWatch(m);
  expect(second.statut).toBe("reussie");
  // Nothing new: no ad page read again, no search, no opinion asked; the widget shows the empty list.
  expect(adReads(from)).toEqual([]);
  expect(searches(from)).toEqual([]);
  expect(ollama.prompts.length).toBe(promptsBefore);
  expect(watchData()).toEqual([]);
  await untilEqual(() => shown(m, "voitures"), "[]");
  // Time for a wrong notification to be written.
  await sleep(1000);
  expect(notifications()).toEqual([NOTIFICATION]);
}, 120_000);

it("a listing whose page fails comes back at the next run", async () => {
  await writeWatch();
  const m = await launchWatch();
  settings.failingPages.add(3);
  const first = await runWatch(m);
  expect(first.statut).toBe("partielle");
  expect(blockStatus(first, "fiche")).toBe("partiel");
  const withoutPage = watchData()!.find((a) => a.url === adUrl(3))!;
  expect(withoutPage.fiche).toBeUndefined();
  expect(withoutPage.avis).toBeUndefined();

  // The page answers again: only ad 3 comes back, read this time; its model (Clio 4), already studied, is not searched.
  settings.failingPages.clear();
  const from = site.log.length;
  const second = await runWatch(m);
  expect(second.statut).toBe("reussie");
  expect(adReads(from)).toEqual(["/annonce/3"]);
  expect(searches(from)).toEqual([]);
  const back = watchData()!;
  expect(back.map((a) => a.url)).toEqual([adUrl(3)]);
  expect(back[0]!.fiche?.texte).toContain("5 900 €");
  expect(back[0]!.fiabilite?.length).toBeGreaterThan(0);
  expect(back[0]!.avis).toBe("Bonne affaire.");
}, 120_000);

it("a long watch in progress does not prevent a short widget from updating", async () => {
  // Each opinion takes 8 s: the watch lasts much longer than the short widget's harvest.
  settings.gemmaDelayMs = 8000;
  await writeWatch();
  await writeWidget(dataDir, "court", {
    nom: "Court",
    recolte: { minutes: 60 },
    fichiers: { "recolte.mjs": "export default async () => ({ court: true });", "exemple.json": JSON.stringify({ exemple: "court" }) },
  });
  const m = await launchWatch();
  await untilEqual(() => shown(m, "court"), '{"exemple":"court"}');
  await harvest(m, "voitures");
  // The watch has started its opinions (Gemma called): it is running, and will stay so for seconds.
  const promptsBefore = ollama.prompts.length;
  await until(() => ollama.prompts.length, (n) => n > promptsBefore, 30_000);
  await harvest(m, "court");
  await untilEqual(() => shown(m, "court"), '{"court":true}', 15_000);
  // Still running: the short widget did not wait for the watch's end.
  expect(readJson(path.join(dataDir, "widgets", "voitures", "etat.json")).statut).toBe("en-cours");
  expect(runs()).toEqual([]);
}, 120_000);

it("DuckDuckGo shows a check: a single request sent, notice without reliability, partial block; the listings come back afterwards with their reliability", async () => {
  settings.ddg = "verification.html";
  await writeWatch();
  const from = site.log.length;
  const promptsBefore = ollama.prompts.length;
  const m = await launchWatch();
  const run = await runWatch(m);
  // One request: after the refusal, the run's next searches are not sent.
  expect(searches(from)).toHaveLength(1);
  expect(blockStatus(run, "fiabilite")).toBe("partiel");
  expect(run.blocs.find((b) => b.id === "fiabilite")!.journal.join("\n")).toContain("Recherche refusée par DuckDuckGo (vérification anti-robot)");
  expect(run.statut).toBe("partielle");
  // No ad has a reliability; the opinion is written without ({fiabilite?}, see AGENTS.md).
  const ads = watchData()!;
  expect(ads).toHaveLength(5);
  for (const a of ads) {
    expect(a.fiche?.texte).toContain("première main");
    expect(a.fiabilite).toBeUndefined();
    expect(a.avis).toBe("Bonne affaire.");
  }
  // Gemma wrote the five opinions, without any reliability text in its prompt.
  const prompts = ollama.prompts.slice(promptsBefore);
  expect(prompts).toHaveLength(5);
  for (const p of prompts) {
    expect(p).toContain("première main");
    expect(p).toContain("--- DÉBUT DES RÉSULTATS DE RECHERCHE ---  --- FIN DES RÉSULTATS DE RECHERCHE ---");
  }

  // The first (partial) run notifies its five ads.
  await untilEqual(notifications, [NOTIFICATION]);

  // DuckDuckGo answers again: the ads failed in `fiabilite` come back, this time with their reliability.
  settings.ddg = "resultats.html";
  const second = await runWatch(m);
  expect(second.statut).toBe("reussie");
  const again = watchData()!;
  expect(again.map((a) => a.url).sort()).toEqual([1, 2, 3, 4, 5].map(adUrl).sort());
  for (const a of again) expect(a.fiabilite?.length).toBeGreaterThan(0);
  // Back, they are not notified a second time. Time for a wrong notification to be written.
  await sleep(1000);
  expect(notifications()).toEqual([NOTIFICATION]);
}, 180_000);

it('the Gmail widget (account, recolte.mjs) updates as before; with "web": true added, it shows in error with the exact message', async () => {
  const gmail = {
    nom: "Gmail",
    recolte: { minutes: 60 },
    declaration: { sources: { compte: ["127.0.0.1"], publiques: [] }, config: { url: `${site.url}/court` } },
    fichiers: {
      "recolte.mjs": "export default async (webaios) => ({ titre: (await webaios.lirePage(webaios.config.url, { compte: true })).titre });",
      "exemple.json": JSON.stringify({ exemple: "gmail" }),
    },
  };
  await writeWidget(dataDir, "gmail", gmail);
  // The grant, already given.
  await writeJson(path.join(dataDir, "widgets", "accords.json"), { gmail: { domaines: ["127.0.0.1"], publiques: [], profil: "defaut" } });
  const m = await launchWatch();
  await harvest(m, "gmail");
  await untilEqual(() => shown(m, "gmail"), '{"titre":"Court"}', 20_000);
  expect(readJson(path.join(dataDir, "widgets", "gmail", "etat.json")).statut).toBe("ok");
  expect(runs("gmail").map((e) => e.statut)).toEqual(["reussie"]);

  // The agent adds "web": true: the widget is refused, with the exact message, and gains no access.
  const from = site.log.length;
  await writeWidget(dataDir, "gmail", { ...gmail, declaration: { ...gmail.declaration, sources: { ...gmail.declaration.sources, web: true } } });
  await until(() => widgetText(m, "gmail"), (t) => t.includes(WEB_WITH_ACCOUNT));
  expect(await inUi(m, `return !!doc.querySelector('[data-testid="widget-gmail"] button[aria-label="Options du widget"]')?.checkVisibility();`)).toBe(true);
  expect(site.log.slice(from)).toEqual([]);
}, 60_000);

it("quitting during the watch: on relaunch, the published listings are there, the run is ended as interrupted", async () => {
  settings.gemmaDelayMs = 6000;
  await writeWatch();
  const first = await launchWatch();
  await harvest(first, "voitures");
  // A first publication (at least one ad shown), then the person quits before the end.
  await until(() => watchData()?.length ?? 0, (n) => n > 0, 60_000);
  await launched.pop()!.close();
  // What was published before the stop: part of the ads, each with its opinion.
  const published = watchData()!;
  expect(published.length).toBeGreaterThan(0);
  expect(published.length).toBeLessThan(5);
  for (const a of published) expect(a.avis).toBe("Bonne affaire.");
  // The run is written « interrompue »; no notification for an interrupted run.
  expect(runs().map((e) => e.statut)).toEqual(["interrompue"]);
  expect(notifications()).toEqual([]);

  settings.gemmaDelayMs = 0;
  const second = await launchWatch();
  await untilEqual(() => shown(second, "voitures"), JSON.stringify(watchData()));
  expect(watchData()!.map((a) => a.url)).toEqual(published.map((a) => a.url));
  // The state is no longer « en cours » (back to the one before), and nothing was started again.
  await untilEqual(() => readJson(path.join(dataDir, "widgets", "voitures", "etat.json")).statut, "ok");
  await untilEqual(() => progress(second, "voitures"), null);
  expect(runs().map((e) => e.statut)).toEqual(["interrompue"]);
}, 120_000);

it("a click on the notification brings the last window to the front, with no tab switch", async () => {
  const m = await launchWatch();
  const second = await newWindow(m);
  await m.command("WebDriver:SwitchToWindow", { handle: second, focus: true });
  const recent = () => m.execute<boolean>("return Services.wm.getMostRecentBrowserWindow() === window;");
  const before = (await state(m)).fenetres.map((f) => f.actif);
  expect(await recent()).toBe(true);
  // Minimized, then clicked: the alert's observer (no alert is shown in test mode) restores and focuses it.
  await m.execute("window.minimize();");
  await until(() => m.execute<number>("return window.windowState;"), (s) => s === 2 /* STATE_MINIMIZED */);
  await m.execute(
    `return (async () => (await ChromeUtils.importESModule("chrome://browser/content/webaios/store.sys.mjs")).alertObserver.observe(null, "alertclickcallback", ""))();`,
  );
  await until(() => m.execute<number>("return window.windowState;"), (s) => s !== 2);
  expect(await recent()).toBe(true);
  expect((await state(m)).fenetres.map((f) => f.actif)).toEqual(before);
}, 60_000);
