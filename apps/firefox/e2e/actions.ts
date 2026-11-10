import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { dispatch, state } from "./firefox";
import type { Marionette } from "./marionette";
import { inUi, waitUi } from "./ui";

// Action helpers. Declarations live in the space
// (`<dataDir>/workspace/actions/<id>/`, `<dataDir>/workspace/components/<nom>/`); runs, results and agreements outside it.

/** The execution every written result belongs to (actions.spec.ts EXECUTION). */
export const EXECUTION = "2026-10-31T08-00-00-000Z";

/** Runs, results and agreements of the actions, outside the space: `<dataDir>/actions/`. */
export const actionsDataDir = (dataDir: string) => path.join(dataDir, "actions");

/** A test action: the keys of `action.json` (`sources` filled by default), its workflow and other files (aide.ts ActionTest). */
export interface TestAction {
  name: string;
  description?: string;
  keywords?: string[];
  input?: { label: string };
  /** `web` is written only when given. */
  sources?: { account?: string[]; public?: string[]; web?: boolean };
  layout?: string;
  maxDurationMinutes?: number;
  /** `workflow.json`: an object is written as JSON, a string as is. */
  workflow?: unknown;
  /** The `code` blocks' `.mjs`, by name. */
  files?: Record<string, string>;
}

/** Writes an action into `<dataDir>/workspace/actions/<id>/`. */
export async function writeAction(dataDir: string, id: string, a: TestAction): Promise<void> {
  const dir = path.join(dataDir, "workspace", "actions", id);
  await mkdir(dir, { recursive: true });
  const { workflow, files: files, sources, ...keys } = a;
  const declaration = { ...keys, sources: { account: sources?.account ?? [], public: sources?.public ?? [], ...(sources?.web !== undefined ? { web: sources.web } : {}) } };
  await writeFile(path.join(dir, "action.json"), JSON.stringify(declaration));
  if (workflow !== undefined) await writeFile(path.join(dir, "workflow.json"), typeof workflow === "string" ? workflow : JSON.stringify(workflow));
  for (const [name, text] of Object.entries(files ?? {})) await writeFile(path.join(dir, name), text);
}

/** An agent component: `component.json` (without `nom`, taken from the folder) and `component.html` (aide.ts ComposantTest). */
export interface TestComponent {
  description: string;
  properties: Record<string, { kind: string; description: string; required?: boolean }>;
  html: string;
}

/** Writes a component into `<dataDir>/workspace/components/<nom>/`. */
export async function writeComponent(dataDir: string, name: string, c: TestComponent): Promise<void> {
  const dir = path.join(dataDir, "workspace", "components", name);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "component.json"), JSON.stringify({ name: name, description: c.description, properties: c.properties }));
  await writeFile(path.join(dir, "component.html"), c.html);
}

/** AGENTS.md:660's « barres » example, unchanged. */
export const BARS = `<!doctype html>
<meta charset="utf-8">
<style>
  body { margin: 0; font: 13px system-ui, sans-serif; color: #222; background: transparent; }
  body.sombre { color: #eee; }
  h3 { margin: 0 0 6px; font-size: 14px; }
</style>
<h3 id="titre"></h3>
<svg id="graphique" width="100%" role="img"></svg>
<script>
  const NS = "http://www.w3.org/2000/svg";
  const el = (nom, attrs, texte) => {
    const e = document.createElementNS(NS, nom);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
    if (texte !== undefined) e.textContent = texte;
    return e;
  };
  addEventListener("message", (m) => {
    if (m.data?.type !== "component") return;
    const { props, theme, width } = m.data;
    document.body.className = theme === "dark" ? "sombre" : "";
    document.getElementById("titre").textContent = props.titre ?? "";
    const valeurs = (Array.isArray(props.valeurs) ? props.valeurs : []).slice(0, 12)
      .map((v) => ({ libelle: String(v?.libelle ?? ""), valeur: Number(v?.valeur) || 0 }));
    const max = Math.max(1, ...valeurs.map((v) => v.valeur));
    const w = Math.max(200, width || 400), h = 24, marge = 110;
    const svg = document.getElementById("graphique");
    svg.replaceChildren();
    svg.setAttribute("viewBox", \`0 0 \${w} \${valeurs.length * h}\`);
    svg.setAttribute("height", valeurs.length * h);
    valeurs.forEach((v, i) => {
      const long = ((w - marge - 40) * v.valeur) / max;
      svg.append(
        el("text", { x: 0, y: i * h + 15, fill: "currentColor" }, v.libelle.slice(0, 16)),
        el("rect", { x: marge, y: i * h + 3, width: long, height: h - 8, rx: 3, fill: "#3b82f6" }),
        el("text", { x: marge + long + 6, y: i * h + 15, fill: "currentColor" }, String(v.valeur)),
      );
    });
    parent.postMessage({ type: "height", px: document.documentElement.scrollHeight }, "*");
  });
</script>
`;

/** A component that tries the network three ways and the chrome, reports through parent.postMessage, then navigates itself. */
export const probe = (base: string) => `<!doctype html><meta charset="utf-8">
<img id="i" src="${base}/img">
<script>
  const out = { Components: typeof Components, ChromeUtils: typeof ChromeUtils, Services: typeof Services, origin: location.origin };
  try { out.top = String(top.document.title); } catch (e) { out.top = e.name; }
  try { out.frameElement = String(frameElement); } catch (e) { out.frameElement = e.name; }
  // Firefox's legacy content Components (plan 31 spike): what it holds, if anything.
  if (typeof Components !== "undefined") out.components = { keys: Object.keys(Components), interfaces: Object.keys(Components.interfaces ?? {}), classes: typeof Components.classes, utils: typeof Components.utils };
  try { fetch("${base}/fetch").then(() => (out.fetch = "loaded"), (e) => (out.fetch = e.name)); } catch (e) { out.fetch = "threw " + e.name; }
  try { const ws = new WebSocket("${base.replace("http", "ws")}/ws"); ws.onerror = () => (out.ws = "error"); ws.onopen = () => (out.ws = "open"); } catch (e) { out.ws = "threw " + e.name; }
  document.getElementById("i").onload = () => (out.img = "loaded");
  document.getElementById("i").onerror = () => (out.img = "error");
  // Then a self-navigation, which would carry data in its URL (which must be blocked).
  setTimeout(() => { parent.postMessage({ type: "sonde", out }, "*"); location.href = "${base}/nav?x=1"; }, 1500);
</script>`;

export type Block = { component: string; props: Record<string, unknown>; blocks?: Block[]; left?: Block[]; right?: Block[] };

/** The action and its last run, with its result. */
export async function writeActionWithResult(
  dataDir: string,
  id: string,
  o: { name: string; account?: string[]; results: unknown; blocks: Block[]; fallback?: boolean },
): Promise<void> {
  await writeAction(dataDir, id, { name: o.name, sources: { account: o.account ?? [] } });
  const data = path.join(actionsDataDir(dataDir), id);
  await mkdir(path.join(data, "runs"), { recursive: true });
  await mkdir(path.join(data, "results"), { recursive: true });
  await writeFile(
    path.join(data, "runs", `${EXECUTION}.json`),
    JSON.stringify({ version: 1, id: EXECUTION, owner: { type: "action", id }, trigger: "manual", start: "2026-10-31T08:00:00.000Z", end: "2026-10-31T08:00:05.000Z", status: "succeeded", blocks: [] }),
  );
  await writeFile(
    path.join(data, "results", `${EXECUTION}.json`),
    JSON.stringify({ version: 1, run: EXECUTION, input: null, results: o.results, plan: { blocks: o.blocks }, fallback: o.fallback ?? false, empty: false }),
  );
}

/** Opens action `id`'s page in a tab of the first window, once the kernel serves it: nothing is launched. */
export async function openActionPage(m: Marionette, id: string, name: string, run = EXECUTION): Promise<void> {
  await waitUi(m, "return ui.webaios.actions.page(arguments[0], arguments[1]).then((p) => p !== null);", [id, run], 30_000);
  await dispatch(m, { type: "openAction", windowId: (await state(m)).windows[0]!.id, id, name: name, run });
  await waitUi(m, `return !!doc.querySelector('[data-testid="page-render"]');`, [], 30_000);
}

/** What the UI says when the actions service does not answer. */
export const WITHOUT_KERNEL = "Le service des actions ne répond pas (agent arrêté ?)";

/** Waits until the kernel serves the actions: an unknown action is then refused as such. */
export async function waitKernel(m: Marionette): Promise<void> {
  await waitUi(m, "return ui.webaios.actions.launch('inconnue-du-test', null).then((r) => r.error !== arguments[0]);", [WITHOUT_KERNEL], 30_000);
}

/** Opens the action's page (its last result, or `execution`) without launching anything. */
export async function openAction(m: Marionette, id: string, name: string, run?: string): Promise<void> {
  await dispatch(m, { type: "openAction", windowId: (await state(m)).windows[0]!.id, id, name: name, ...(run ? { run } : {}) });
  await waitUi(m, `return !!doc.querySelector('[data-testid="page-action"]');`, [], 10_000);
}

/** A workflow whose blocks follow one another in the array's order (actions.spec.ts enChaine). */
export const chained = (blocks: { id: string; type: string; params: Record<string, unknown> }[]) => ({
  version: 1,
  blocks: blocks,
  links: blocks.slice(1).map((b, i) => ({ from: blocks[i]!.id, to: b.id })),
});

/** A runnable action: a `code` block, the blocks between, then the output to the page. */
export function writeRunnableAction(
  dataDir: string,
  id: string,
  o: { name: string; code: string; account?: string[]; input?: string; keywords?: string[]; blocks?: { id: string; type: string; params: Record<string, unknown> }[] },
): Promise<void> {
  const blocks = [{ id: "liste", type: "code", params: { source: "liste.mjs" } }, ...(o.blocks ?? []), { id: "sortie", type: "output", params: { to: "page" } }];
  return writeAction(dataDir, id, {
    name: o.name,
    sources: { account: o.account ?? [] },
    ...(o.keywords ? { keywords: o.keywords } : {}),
    ...(o.input ? { input: { label: o.input } } : {}),
    workflow: chained(blocks),
    files: { "liste.mjs": o.code },
  });
}

/** Three pages of the slow site, read one by one: « Lecture de 127.0.0.1… » then « 3 / 3 ». */
export const writePagesAction = (dataDir: string, siteUrl: string, id = "pages", name = "Pages") =>
  writeRunnableAction(dataDir, id, {
    name: name,
    code: `export default async () => [1, 2, 3].map((n) => ({ url: "${siteUrl}/lent/" + n }));`,
    blocks: [{ id: "lecture", type: "source.page", params: { url: "{url}", perItem: true, field: "page" } }],
  });

/** Finished runs written on disk for this action, without temporary files. */
export async function runsOnDisk(dataDir: string, id: string): Promise<string[]> {
  const dir = path.join(actionsDataDir(dataDir), id, "runs");
  return (await readdir(dir).catch(() => [])).filter((f) => f.endsWith(".json")).sort();
}

/** The status of each finished run on disk, oldest first. */
export async function runStatuses(dataDir: string, id: string): Promise<string[]> {
  const dir = path.join(actionsDataDir(dataDir), id, "runs");
  return Promise.all((await runsOnDisk(dataDir, id)).map(async (f) => (JSON.parse(await readFile(path.join(dir, f), "utf8")) as { status: string }).status));
}

/** A finished run and its result (a title), written on disk. */
export async function writeResult(dataDir: string, id: string, run: string, start: string, title: string, input: string | null = null): Promise<void> {
  const data = path.join(actionsDataDir(dataDir), id);
  await mkdir(path.join(data, "runs"), { recursive: true });
  await mkdir(path.join(data, "results"), { recursive: true });
  await writeFile(
    path.join(data, "runs", `${run}.json`),
    JSON.stringify({ version: 1, id: run, owner: { type: "action", id }, trigger: "manual", start: start, end: start, status: "succeeded", ...(input ? { input: input } : {}), blocks: [] }),
  );
  await writeFile(
    path.join(data, "results", `${run}.json`),
    JSON.stringify({ version: 1, run: run, input: input, results: { title: title }, plan: { blocks: [{ component: "title", props: { text: title } }] }, fallback: false, empty: false }),
  );
}

export const tid = (id: string) => `[data-testid="${id}"]`;

/** Reads and waits on the sidebar UI's elements by CSS selector (Playwright's locators, as these files need them). */
export function uiQueries(m: Marionette) {
  const text = (selector: string) => inUi<string | null>(m, "return doc.querySelector(arguments[0])?.textContent ?? null;", [selector]);
  const count = (selector: string) => inUi<number>(m, "return doc.querySelectorAll(arguments[0]).length;", [selector]);
  /** Fails with the last text seen. */
  const until = async (selector: string, ok: (t: string | null) => boolean, what: string, ms: number) => {
    const deadline = Date.now() + ms;
    for (let t = await text(selector); ; t = await text(selector)) {
      if (ok(t)) return;
      if (Date.now() > deadline) throw new Error(`${selector}: expected ${what}, got ${JSON.stringify(t)}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  return {
    text,
    count,
    waitText: (selector: string, expected: string, ms = 10_000) => until(selector, (t) => t?.trim() === expected, JSON.stringify(expected), ms),
    waitContains: (selector: string, part: string, ms = 10_000) => until(selector, (t) => !!t?.includes(part), `to contain ${JSON.stringify(part)}`, ms),
    waitCount: (selector: string, n: number, ms = 10_000) => waitUi(m, "return doc.querySelectorAll(arguments[0]).length === arguments[1];", [selector, n], ms),
    value: (selector: string) => inUi<string | null>(m, "return doc.querySelector(arguments[0])?.value ?? null;", [selector]),
  };
}

export interface TestServer {
  url: string;
  log: string[];
  close(): Promise<void>;
}

/** A local server, each URL asked noted in `log`. */
export async function listen(handle: (req: IncomingMessage, res: ServerResponse, body: string) => void): Promise<TestServer> {
  const log: string[] = [];
  const server = createServer((req, res) => {
    log.push(req.url ?? "/");
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => handle(req, res, body));
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, log, close: () => new Promise((ok) => (server.closeAllConnections(), server.close(() => ok()))) };
}

export type GitlabTicket = { n: number; title: string; project: string; priority: string };
export const GITLAB_TICKETS: GitlabTicket[] = [
  { n: 1, title: "Connexion impossible", project: "api", priority: "urgent" },
  { n: 2, title: "Facture en double", project: "facturation", priority: "normale" },
  { n: 3, title: "Fuite mémoire du worker", project: "api", priority: "urgent" },
  { n: 4, title: "Coquille sur l'accueil", project: "site", priority: "basse" },
  { n: 5, title: "Export CSV lent", project: "facturation", priority: "normale" },
];
export const LBC_ADS = [
  { n: 1, title: "Renault Clio 4", price: 7200, city: "Lyon" },
  { n: 2, title: "Renault Clio 3", price: 4900, city: "Villeurbanne" },
];
export const adPhoto = (n: number) => `https://img.leboncoin.exemple/photos/${n}.jpg`;

/** The fake Gemma's plan for a layout request: a title, then the list of pages read (actions.spec.ts PLAN_GEMMA). */
export const GEMMA_PLAN = { blocks: [{ component: "title", props: { text: "Pages lues" } }, { component: "list", props: { items: "$", title: "page.title" } }] };
/** The start of the layout prompt (pages/layout-page.ts). */
export const LAYOUT_PROMPT = "Tu mets en page le résultat d'une action pour l'utilisateur.";

/** A 1×1 red PNG. */
export const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64");

/** What the image server received: path, Cookie and Referer of each request. */
export type ImageRequestSeen = { path: string; cookie: string | null; referer: string | null };

/**
 * The action servers (the site, the fake Gemma and `reglages`, reset by `reset()`), plus the
 * fake Kev, and an image server noting each request's path, Cookie and Referer. Image server paths: `/cookie` sets
 * `seen=<value of ?v>` (a page), `*.png` a PNG with a Set-Cookie, `*\/r` a 302 to `/secret` (absolute http URL),
 * `/hop` a 302 to `/p.png`, `/secret` a PNG, `*.jpg` a PNG too, `*\/html.png` an HTML page, `*\/big.png` 6 MB.
 */
export async function startActionServers() {
  const settings: { siteSlownessMs: number; gemmaSlownessMs: number; plan: unknown; tickets: GitlabTicket[] } = { siteSlownessMs: 0, gemmaSlownessMs: 0, plan: null, tickets: GITLAB_TICKETS };
  const pages: Record<string, () => string> = {
    "/gitlab/tickets": () =>
      `<title>Tickets</title><h1>Tableau de bord</h1><ul>${settings.tickets.map((t) => `<li><a href="/gitlab/ticket/${t.n}">#${t.n} ${t.title} [${t.priority}] (${t.project})</a></li>`).join("")}</ul><a href="/gitlab/aide">Aide</a>`,
    "/leboncoin/recherche": () =>
      `<title>Annonces</title><ul>${LBC_ADS.map((a) => `<li><a href="https://www.leboncoin.exemple/ad/${a.n}">${a.title} – ${a.price} – ${a.city}</a> <a href="${adPhoto(a.n)}">Photo</a></li>`).join("")}</ul>`,
    "/court": () => "<title>Court</title>",
    "/veille": () => `<title>Veille</title><ul><li><a href="/annonce/1">Vélo de course</a></li><li><a href="/annonce/2">Vélo pliant</a></li></ul>`,
  };
  const html = (res: ServerResponse, body: string) => res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(body);
  const site = await listen((req, res) => {
    const p = new URL(req.url ?? "/", "http://x").pathname;
    const page = pages[p];
    if (page) return void setTimeout(() => html(res, page()), p.startsWith("/gitlab/") ? settings.siteSlownessMs : 0);
    const n = /^\/lent\/(\d+)$/.exec(p)?.[1];
    if (!n) return void res.writeHead(404).end();
    setTimeout(() => html(res, `<title>Page ${n}</title><p>Texte ${n}</p>`), settings.siteSlownessMs);
  });
  const prompts: string[] = [];
  const ollama = await listen((req, res, body) => {
    if (req.url !== "/api/chat") return void res.writeHead(200, { "Content-Type": "application/json" }).end('{"models":[]}');
    const prompt = String((JSON.parse(body) as { messages: { content: string }[] }).messages[0]?.content);
    prompts.push(prompt);
    const plan = settings.plan ?? GEMMA_PLAN;
    const content = !prompt.startsWith(LAYOUT_PROMPT) ? "Bonne affaire." : typeof plan === "string" ? plan : JSON.stringify(plan);
    setTimeout(() => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ message: { content } })), settings.gemmaSlownessMs);
  });
  // Fake Kev (watch.e2e.ts): every item matches.
  const kev = await listen((req, res) => {
    if (req.method === "GET") return void res.writeHead(200, { "Content-Type": "application/json" }).end('{"data":[]}');
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ answers: { q: { noul: 0.9 } } }));
  });
  const seen: ImageRequestSeen[] = [];
  const images = await listen((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    seen.push({ path: u.pathname, cookie: req.headers.cookie ?? null, referer: req.headers.referer ?? null });
    if (u.pathname === "/cookie") return void res.writeHead(200, { "Content-Type": "text/html", "Set-Cookie": `seen=${u.searchParams.get("v") ?? "1"}; Max-Age=3600; Path=/` }).end("<title>cookie</title>");
    if (u.pathname.endsWith("/r")) return void res.writeHead(302, { Location: `${images.url}/secret` }).end();
    if (u.pathname === "/hop") return void res.writeHead(302, { Location: `${images.url}/p.png` }).end();
    // Hostile images (Review Focus 3): not an image, or over the 5 MB limit.
    if (u.pathname.endsWith("/html.png")) return void res.writeHead(200, { "Content-Type": "text/html" }).end("<title>pas une image</title>");
    if (u.pathname.endsWith("/big.png")) return void res.writeHead(200, { "Content-Type": "image/png" }).end(Buffer.alloc(6 * 1024 * 1024));
    if (u.pathname.endsWith(".png") || u.pathname.endsWith(".jpg") || u.pathname === "/secret") return void res.writeHead(200, { "Content-Type": "image/png", "Set-Cookie": "leak=1; Max-Age=3600; Path=/" }).end(PNG);
    res.writeHead(404).end();
  });
  return {
    site,
    ollama: Object.assign(ollama, { prompts }),
    kev,
    images: Object.assign(images, { seen }),
    settings,
    /** actions.spec.ts beforeEach. */
    reset() {
      Object.assign(settings, { siteSlownessMs: 0, gemmaSlownessMs: 0, plan: null, tickets: GITLAB_TICKETS });
      seen.length = 0;
    },
    close: () => Promise.all([site, ollama, kev, images].map((s) => s.close())),
  };
}
