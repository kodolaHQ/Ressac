import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { accorderSite, DeclarationSite } from "../../../packages/noyau/src/index";
import type { Marionette } from "./marionette";

// Site app helpers.

/** What a route of startSitesServer answers: an HTML text, or the hand on the response. */
export type SiteRoute = string | ((req: IncomingMessage, res: ServerResponse) => void);

/**
 * One server for every `*.localhost` test host, answering by the Host header. `definir(hote,
 * chemin, route)` adds a page; `/cookie` sets a cookie on any host; `couper(hote)` resets that host's connections (a
 * stopped site). Every request received is noted in `requetes`, with its method.
 * Firefox resolves these names only with a DNS override: see `resolveLocalHosts`. `port`: a fixed one (default: any free port).
 */
export async function startSitesServer(o: { port?: number } = {}): Promise<{
  port: number;
  /** `http://<host>:<port><path>`. */
  url(host: string, relPath?: string): string;
  definir(host: string, relPath: string, route: SiteRoute): void;
  couper(host: string, yes?: boolean): void;
  requetes: { hote: string; chemin: string; methode: string; cookie: string | undefined }[];
  fermer(): Promise<void>;
}> {
  const routes = new Map<string, SiteRoute>();
  const coupes = new Set<string>();
  const requests: { hote: string; chemin: string; methode: string; cookie: string | undefined }[] = [];
  const server = createServer((req, res) => {
    const host = (req.headers.host ?? "").replace(/:\d+$/, "").toLowerCase();
    const relPath = req.url ?? "/";
    requests.push({ hote: host, chemin: relPath, methode: req.method ?? "GET", cookie: req.headers.cookie });
    if (coupes.has(host)) return void req.socket.resetAndDestroy();
    const route = routes.get(`${host} ${relPath}`) ?? routes.get(`${host} ${relPath.split("?")[0]}`);
    if (typeof route === "function") return route(req, res);
    if (typeof route === "string") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return void res.end(route);
    }
    if (relPath === "/cookie") {
      res.writeHead(200, { "Set-Cookie": `essai=${host}; Max-Age=86400; Path=/`, "Content-Type": "text/html" });
      return void res.end("<title>cookie</title>ok");
    }
    if (relPath === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return void res.end(`<title>${host}</title><p>${host}</p>`);
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((ok) => server.listen(o.port ?? 0, "127.0.0.1", ok));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    url: (host, relPath = "/") => `http://${host}:${port}${relPath}`,
    definir: (host, relPath, route) => void routes.set(`${host} ${relPath}`, route),
    couper: (host, yes = true) => void (yes ? coupes.add(host) : coupes.delete(host)),
    requetes: requests,
    fermer: () =>
      new Promise((ok) => {
        server.closeAllConnections();
        server.close(() => ok());
      }),
  };
}

/** Points the test host names at 127.0.0.1 (chrome context): Firefox does not resolve `*.localhost` names itself. */
export function resolveLocalHosts(m: Marionette, hosts: string[]): Promise<unknown> {
  return m.execute(
    `const o = Cc["@mozilla.org/network/native-dns-override;1"].getService(Ci.nsINativeDNSResolverOverride);
     for (const h of arguments[0]) o.addIPOverride(h, "127.0.0.1");`,
    [hosts],
  );
}

/** A test site app: `site.json` (an object, written as JSON; a string, as is) and other files. */
export interface SiteTest {
  declaration: object | string;
  /** Paths relative to the app's folder (`accueil/index.html`, `retouches/a.js`…) → content. */
  fichiers?: Record<string, string | Buffer>;
}

/** Writes a site app into `<dataDir>/espace/sites/<id>/` (what the agent would write there). */
export function writeSite(dataDir: string, id: string, s: SiteTest): void {
  const dossier = path.join(dataDir, "espace", "sites", id);
  mkdirSync(dossier, { recursive: true });
  writeFileSync(path.join(dossier, "site.json"), typeof s.declaration === "string" ? s.declaration : JSON.stringify(s.declaration));
  for (const [relPath, content] of Object.entries(s.fichiers ?? {})) {
    mkdirSync(path.join(dossier, relPath, ".."), { recursive: true });
    writeFileSync(path.join(dossier, relPath), content);
  }
}

/** « Autoriser » done ahead (`<dataDir>/sites-accords.json`), by the kernel's own accorderSite: the app opens granted. */
export const grantSite = (dataDir: string, id: string, declaration: object): Promise<void> => accorderSite(dataDir, id, DeclarationSite.parse(declaration));

/** The test home page: it shows the memory it receives and notes every message. */
export const SITE_HOME = `<!doctype html><meta charset="utf-8"><title>Accueil</title>
<ul id="series"></ul><p id="domaine"></p><button id="ouvrir">Reprendre</button>
<script>
  window.recus = [];
  window.adresse = "/";
  document.getElementById("ouvrir").addEventListener("click", () => parent.postMessage({ type: "ouvrir", adresse: window.adresse }, "*"));
  addEventListener("message", (e) => {
    window.recus.push(e.data);
    if (e.data && e.data.type === "memoire") {
      const ul = document.getElementById("series");
      ul.textContent = "";
      for (const [cle, v] of Object.entries(e.data.valeurs)) {
        const li = document.createElement("li");
        li.textContent = cle + " : " + v.valeur.titre + " " + v.adresse;
        ul.append(li);
      }
      document.getElementById("domaine").textContent = e.data.domaine;
    }
  });
  parent.postMessage({ type: "pret" }, "*");
</script>`;

/** Chrome-context expression: the window of site app `id` (the attribute set by setupSiteWindow), or undefined. */
export const siteWindowExpr = (id: string) =>
  `[...Services.wm.getEnumerator("navigator:browser")].find((w) => w.document.documentElement.getAttribute("webaios-site") === ${JSON.stringify(id)})`;

/** How many windows app `id` has open (chrome context). */
export const siteWindowCount = (m: Marionette, id: string) =>
  m.execute<number>(`return [...Services.wm.getEnumerator("navigator:browser")].filter((w) => w.document.documentElement.getAttribute("webaios-site") === arguments[0]).length;`, [id]);

/**
 * Runs `body` (an async function body, chrome context) with `win` = the app's window and `doc` = its bar's document
 * (once loaded). `arguments[i]` are the args.
 */
export function inSiteBar<T = unknown>(m: Marionette, id: string, body: string, args: unknown[] = []): Promise<T> {
  return m.execute<T>(
    `return (async () => {
      let win, frame;
      for (let i = 0; i < 100; i++) {
        win = ${siteWindowExpr(id)};
        frame = win?.document.getElementById("webaios-site-bar");
        if (frame?.contentDocument?.readyState === "complete" && frame.contentDocument.documentURI.startsWith("chrome:")) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      const doc = frame.contentDocument;
      ${body}
    })();`,
    args,
  );
}

const NAVIGABLES = "chrome://remote/content/shared/NavigableManager.sys.mjs";

/**
 * Runs `script` (a WebDriver script: `return …`) in the content of the <browser> that the chrome expression `browser`
 * gives, in its `frame`-th frame if given; with `gesture`, from the click handler of a trusted click (WebDriver
 * actions), so the page has a user activation. Comes back to the chrome context and the window it left.
 */
export async function inBrowser<T>(m: Marionette, browser: string, script: string, o: { frame?: number; gesture?: boolean } = {}): Promise<T> {
  const main = (await m.command<{ value: string }>("WebDriver:GetWindowHandle")).value;
  const handle = await m.execute<string>(`return ChromeUtils.importESModule("${NAVIGABLES}").NavigableManager.getIdForBrowser(${browser});`);
  await m.command("WebDriver:SwitchToWindow", { handle, focus: false });
  await m.setContext("content");
  try {
    if (o.frame !== undefined) await m.command("WebDriver:SwitchToFrame", { id: o.frame });
    if (!o.gesture) return await m.execute<T>(script);
    // The script becomes the handler of a button on top of the page; a trusted click runs it.
    await m.execute(
      `const b = document.createElement("button");
       b.id = "webaios-test-gesture";
       b.style.cssText = "position: fixed; left: 0; top: 0; width: 20px; height: 20px; z-index: 2147483647";
       b.onclick = () => { b.remove(); window.__gestureResult = (function () { ${script} })(); };
       document.documentElement.append(b);`,
    );
    const found = await m.command<{ value: Record<string, string> }>("WebDriver:FindElement", { using: "css selector", value: "#webaios-test-gesture" });
    await m.command("WebDriver:PerformActions", {
      actions: [{ type: "pointer", id: "mouse", parameters: { pointerType: "mouse" }, actions: [{ type: "pointerMove", origin: found.value, x: 0, y: 0 }, { type: "pointerDown", button: 0 }, { type: "pointerUp", button: 0 }] }],
    });
    await m.command("WebDriver:ReleaseActions");
    return (await m.execute<T>("return window.__gestureResult;").catch(() => undefined)) as T;
  } finally {
    if (o.frame !== undefined) await m.command("WebDriver:SwitchToFrame", {}).catch(() => {});
    await m.setContext("chrome");
    await m.command("WebDriver:SwitchToWindow", { handle: main, focus: false });
  }
}

/** Runs `script` in the content of app `id`'s view (see inBrowser). */
export const inSiteView = <T>(m: Marionette, id: string, script: string, o: { frame?: number; gesture?: boolean } = {}): Promise<T> =>
  inBrowser<T>(m, `${siteWindowExpr(id)}.gBrowser.selectedBrowser`, script, o);

/** `seconds` of 8 kHz silence as a WAV, a video as far as the player cares. */
export function silenceWav(seconds = 3): Buffer {
  const n = 8000 * seconds;
  const b = Buffer.alloc(44 + n, 0x80);
  b.write("RIFF", 0);
  b.writeUInt32LE(36 + n, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(8000, 24);
  b.writeUInt32LE(8000, 28);
  b.writeUInt16LE(1, 32);
  b.writeUInt16LE(8, 34);
  b.write("data", 36);
  b.writeUInt32LE(n, 40);
  return b;
}

/** A WAV served with byte ranges, like a real video server, so the player can seek to the minute. */
export const serveWav = (wav: Buffer): SiteRoute => (req, res) => {
  const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? "");
  if (!range) return void res.writeHead(200, { "Content-Type": "audio/wav", "Content-Length": wav.length, "Accept-Ranges": "bytes" }).end(wav);
  const from = Number(range[1]);
  const to = range[2] ? Math.min(Number(range[2]), wav.length - 1) : wav.length - 1;
  res.writeHead(206, { "Content-Type": "audio/wav", "Content-Length": to - from + 1, "Content-Range": `bytes ${from}-${to}/${wav.length}`, "Accept-Ranges": "bytes" });
  res.end(wav.subarray(from, to + 1));
};
