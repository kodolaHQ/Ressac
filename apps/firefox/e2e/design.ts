import { readFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import path from "node:path";
import { cleanSource, firefoxViewfinderScript, sourceExpression, STOP_SCRIPT } from "../chrome/store/design-copies";
import type { Marionette } from "./marionette";
import { startServer } from "./server";
import { inBrowser } from "./sites";

// The design mode's e2e helpers and pages (plans 35a and 35b), from the spikes of
// docs/superpowers/notes/2026-11-06-mode-design-firefox-spikes.md (e2e/spikes/design.e2e.ts). Chrome context.

/** design.html (form#inscription, input#email.champ, button#envoyer, a#lien, a data-source, #nue, ul > li × 3), plus a page global the viewfinder must not see. */
export const DESIGN_PAGE = readFileSync(path.resolve(import.meta.dirname, "pages/design.html"), "utf8").replace("window.reactions = [];", 'window.reactions = []; window.pageSecret = "secret";');

const MOUSE = ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "auxclick", "contextmenu", "dblclick"];

/**
 * DESIGN_PAGE with a page that listens first (in its head: window capture, document capture and bubble), hooks the
 * prototypes the viewfinder could call and fakes its stop. Everything it sees goes to `window.log`.
 */
export const HOOKS_PAGE = DESIGN_PAGE.replace(
  "<head>",
  `<head><script>
  window.log = { early: [], docEarly: [], hooked: [], keys: [], fakeStop: 0 };
  for (const t of ${JSON.stringify(MOUSE)}) {
    window.addEventListener(t, (e) => log.early.push(t + ":" + e.isTrusted), true);
    document.addEventListener(t, (e) => log.docEarly.push(t + ":capture:" + e.isTrusted), true);
    document.addEventListener(t, (e) => log.docEarly.push(t + ":bubble:" + e.isTrusted));
  }
  window.addEventListener("keydown", (e) => log.keys.push(e.key + ":" + e.isTrusted), true);
  const hook = (o, k) => { const f = o[k]; o[k] = function (...a) { log.hooked.push(k); return f.apply(this, a); }; };
  hook(Element.prototype, "attachShadow"); hook(Document.prototype, "createElement"); hook(EventTarget.prototype, "addEventListener");
  hook(window, "getComputedStyle"); hook(Element.prototype, "getBoundingClientRect"); hook(CSS, "escape"); hook(Document.prototype, "querySelectorAll");
  const then = Promise.prototype.then; Promise.prototype.then = function (...a) { log.hooked.push("then"); return then.apply(this, a); };
  window.__viseurArret = () => log.fakeStop++; window.__viseurAvaler = () => log.fakeStop++; window.__viseurChoisir = () => log.fakeStop++;
  addEventListener("load", () => (log.hooked.length = 0));
</script>`,
);

/** A strict CSP page: nonce scripts, Trusted Types. */
export const CSP = "default-src 'none'; script-src 'nonce-essai'; style-src 'self'; require-trusted-types-for 'script'; trusted-types 'none'";
export const CSP_PAGE = '<!doctype html><meta charset="utf-8"><title>CSP</title><button id="b">ok</button>';

/** A frame page that logs what its window capture listeners see (`window.log.early`). */
export const FRAME_PAGE = `<!doctype html><meta charset="utf-8"><title>cadre</title><body style="margin:0"><button id="dans" style="margin:20px">dans</button>
<script>window.log = { early: [] }; for (const t of ${JSON.stringify(MOUSE)}) addEventListener(t, (e) => log.early.push(t + ":" + e.isTrusted), true);</script></body>`;

/** DESIGN_PAGE with a frame of another site (`frameUrl`), so of another process. */
export const OOP_PAGE = (frameUrl: string) => DESIGN_PAGE.replace("</body>", `<iframe id="cadre" src="${frameUrl}" style="width:300px;height:120px;border:0"></iframe></body>`);

/** Spike S2's page: a green 80×30 target at (300, 900) on a white page 3000 px high. */
export const TARGET_PAGE = '<!doctype html><meta charset="utf-8"><title>cible</title><style>body{margin:0;height:3000px;background:#fff}</style><div id="cible" style="position:absolute;left:300px;top:900px;width:80px;height:30px;background:rgb(0,200,0)"></div>';

const send = (body: string, headers: Record<string, string> = {}) => (_req: unknown, res: ServerResponse) =>
  void res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", ...headers }).end(body);

/**
 * Two servers on 127.0.0.1: the pages (`page`, reached as 127.0.0.1) and the frame (`frame`, reached as localhost: another
 * site, so another process). `/`, `/x`, `/hooks`, `/csp`, `/oop` (DESIGN_PAGE with the frame), `/cible` and `/frame` on
 * both. `port`: the pages' port (a demo port in WEBAIOS_APP_PORTS makes them a demo project).
 */
export async function startDesignServers(o: { port?: number } = {}): Promise<{ page: string; frame: string; paths: string[]; close(): Promise<void> }> {
  let frame = "";
  const routes = {
    "/": send(DESIGN_PAGE),
    "/x": send(DESIGN_PAGE),
    "/hooks": send(HOOKS_PAGE),
    "/csp": send(CSP_PAGE, { "Content-Security-Policy": CSP }),
    "/frame": send(FRAME_PAGE),
    "/cible": send(TARGET_PAGE),
    "/oop": (req: unknown, res: ServerResponse) => send(OOP_PAGE(`${frame}/frame`))(req, res),
  };
  const [a, b] = await Promise.all([startServer({ routes, port: o.port }), startServer({ routes })]);
  frame = `http://localhost:${b.port}`;
  return { page: a.url, frame, paths: a.paths, close: () => Promise.all([a.close(), b.close()]).then(() => {}) };
}

const actor = (browserExpr: string, frame?: number) =>
  `${browserExpr}.browsingContext${frame === undefined ? "" : `.children[${frame}]`}.currentWindowGlobal.getActor("WebAiOsDesign")`;

/**
 * Arms the viewfinder in the top window of `browserExpr` (Firefox's script by default); `result(ms)` waits for its answer:
 * `{ r }`, `{ e }` when the query is rejected, or "pending" after `ms`.
 */
export async function armActor(m: Marionette, browserExpr: string, code = firefoxViewfinderScript()) {
  const key = `a${Date.now()}${Math.random()}`;
  await m.execute(
    `(window.__designArms ??= {})[arguments[1]] = ${actor(browserExpr)}.sendQuery("arm", { code: arguments[0] }).then((r) => ({ r }), (e) => ({ e: String(e) })); return true;`,
    [code, key],
  );
  return {
    result: (ms = 10_000) =>
      m.execute<{ r?: any; e?: string } | "pending">(
        `return Promise.race([window.__designArms[arguments[0]], new Promise((ok) => setTimeout(() => ok("pending"), arguments[1]))]);`,
        [key, ms],
      ),
  };
}

export const stopActor = (m: Marionette, browserExpr: string) => m.execute(`return ${actor(browserExpr)}.sendQuery("stop", { code: arguments[0] });`, [STOP_SCRIPT]);

/** The guard (mouse only, never picks) in the `i`-th child frame of `browserExpr`'s top window, a process root. */
export const guardFrame = (m: Marionette, browserExpr: string, i: number) =>
  m.execute<unknown>(
    `const wg = ${browserExpr}.browsingContext.children[arguments[0]].currentWindowGlobal;
     if (!wg.isProcessRoot) throw new Error("not a process root");
     return wg.getActor("WebAiOsDesign").sendQuery("guard");`,
    [i],
  );

export const unguardFrame = (m: Marionette, browserExpr: string, i: number) => m.execute(`return ${actor(browserExpr, i)}.sendQuery("unguard");`);

/** A raw query to the actor of the top window (or the `frame`-th child frame). */
export const askActor = <T = unknown>(m: Marionette, browserExpr: string, name: string, data?: unknown, frame?: number) =>
  m.execute<T>(`return ${actor(browserExpr, frame)}.sendQuery(arguments[0], arguments[1]);`, [name, data]);

/** Reads the source: the expression in the page's world, then sourceSaine. */
export async function readSource(m: Marionette, browserExpr: string, selector: string) {
  return cleanSource(await askActor(m, browserExpr, "source", { code: sourceExpression(selector) }));
}

/** The centre of `selector` in `browserExpr`'s viewport (CSS px), in its `frame`-th frame if given. */
export async function center(m: Marionette, browserExpr: string, selector: string, frame?: number): Promise<{ x: number; y: number }> {
  const rect = `const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };`;
  const c = await inBrowser<{ x: number; y: number }>(m, browserExpr, rect, frame === undefined ? {} : { frame });
  if (frame === undefined) return c;
  const f = await inBrowser<{ x: number; y: number }>(m, browserExpr, `const f = document.querySelectorAll("iframe")[${frame}], r = f.getBoundingClientRect(); return { x: r.x + f.clientLeft, y: r.y + f.clientTop };`);
  return { x: f.x + c.x, y: f.y + c.y };
}

const NAVIGABLES = "chrome://remote/content/shared/NavigableManager.sys.mjs";

/**
 * A trusted mouse gesture over `browserExpr` (it must be the selected tab): a move, then `count` clicks of `button` (a
 * right click adds contextmenu). In the top window: sent from the chrome window as a person's, at `at` (a selector, see
 * center, or a point). In the `frame`-th frame: WebDriver actions in that frame's process. Measured: headless Firefox
 * has no APZ, so a gesture the chrome window sends over a frame of another process stops at its <iframe> in the top
 * document; actions start where a person's click lands in that process (its PresShell), so the event takes the same
 * path through the frame's chrome event handler.
 */
export async function trustedMouse(m: Marionette, browserExpr: string, at: string | { x: number; y: number }, o: { button?: 0 | 1 | 2; count?: number; frame?: number; move?: boolean } = {}): Promise<void> {
  const button = o.button ?? 0;
  const count = o.count ?? 1;
  if (o.frame !== undefined) {
    if (typeof at !== "string") throw new Error("a frame gesture takes a selector");
    const main = (await m.command<{ value: string }>("WebDriver:GetWindowHandle")).value;
    const handle = await m.execute<string>(`return ChromeUtils.importESModule("${NAVIGABLES}").NavigableManager.getIdForBrowser(${browserExpr});`);
    await m.command("WebDriver:SwitchToWindow", { handle, focus: false });
    await m.setContext("content");
    try {
      await m.command("WebDriver:SwitchToFrame", { id: o.frame });
      const found = await m.command<{ value: Record<string, string> }>("WebDriver:FindElement", { using: "css selector", value: at });
      const clicks = o.move ? [] : Array.from({ length: count }, () => [{ type: "pointerDown", button }, { type: "pointerUp", button }]).flat();
      await m.command("WebDriver:PerformActions", { actions: [{ type: "pointer", id: "mouse", parameters: { pointerType: "mouse" }, actions: [{ type: "pointerMove", origin: found.value, x: 0, y: 0 }, ...clicks] }] });
      await m.command("WebDriver:ReleaseActions");
    } finally {
      await m.command("WebDriver:SwitchToFrame", {}).catch(() => {});
      await m.setContext("chrome");
      await m.command("WebDriver:SwitchToWindow", { handle: main, focus: false });
    }
    return;
  }
  const c = typeof at === "string" ? await center(m, browserExpr, at) : at;
  await m.execute(
    `return (async ([c, button, count, move]) => {
     const b = ${browserExpr}, br = b.getBoundingClientRect(), z = b.fullZoom;
     const x = br.left + c.x * z, y = br.top + c.y * z;
     window.synthesizeMouseEvent("mousemove", x, y, { button: 0, clickCount: 0 });
     await new Promise((r) => setTimeout(r, 50));
     if (move) return;
     for (let i = 1; i <= count; i++) { window.synthesizeMouseEvent("mousedown", x, y, { button, clickCount: i }); window.synthesizeMouseEvent("mouseup", x, y, { button, clickCount: i }); }
     if (button === 2) window.synthesizeMouseEvent("contextmenu", x, y, { button: 2, clickCount: 1 });
     })(arguments);`,
    [c, button, count, o.move ?? false],
  );
}

/** What the page (or its `frame`-th frame) saw: `window.reactions` (design.html) and `window.log` (HOOKS_PAGE, FRAME_PAGE). */
export const pageLog = (m: Marionette, browserExpr: string, frame?: number) =>
  inBrowser<{ reactions?: string[]; early?: string[]; docEarly?: string[]; hooked?: string[]; keys?: string[]; fakeStop?: number }>(
    m,
    browserExpr,
    "return JSON.parse(JSON.stringify({ reactions: window.reactions, ...window.log }));",
    frame === undefined ? {} : { frame },
  );

/** Empties the page's (or frame's) logs. */
export const clearLog = (m: Marionette, browserExpr: string, frame?: number) =>
  inBrowser(
    m,
    browserExpr,
    "if (window.reactions) window.reactions.length = 0; for (const v of Object.values(window.log ?? {})) if (Array.isArray(v)) v.length = 0; if (window.log) window.log.fakeStop = 0; return 1;",
    frame === undefined ? {} : { frame },
  );
