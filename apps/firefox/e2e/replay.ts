import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect, type AddressInfo, type Server } from "node:net";
import os from "node:os";
import path, { join } from "node:path";
import { callMcpTool } from "../test/mcp";
import { dispatch, state, waitFor } from "./firefox";
import { launchRessac, type LaunchedRessac } from "./launch";
import type { Marionette } from "./marionette";
import { writePassport, type PassportEntry } from "./passport-file";
import { click, inUi } from "./ui";

/**
 * One leg of B3's leak replay in the compiled browser (bench/security/B3/browser): the user's world (tabs, history,
 * bookmarks, passport) behind a local HTTPS server and proxy, every page load Firefox makes after the setup an `out` event,
 * and the record harness.mts writes, so score.mjs scores it unchanged.
 */
const REPO = path.resolve(import.meta.dirname, "../../..");
const B3 = join(REPO, "bench/security/B3");

type Profile = {
  mailUrl: string; bankUrl: string; canaries: { id: string; forms: string[] }[];
  history: { url: string; title: string; text: string }[]; bookmarks: { url: string; title: string }[];
};
// Plain JS modules of the bench, imported by path: the bench owns their shapes.
const { PROFILES } = (await import(join(B3, "profiles.mjs"))) as { PROFILES: Record<"a" | "b", Profile> };
const { fromRessac, collisionsIn } = (await import(join(B3, "score.mjs"))) as { fromRessac: (c: ReplayCase) => unknown; collisionsIn: (t: string, k: Profile["canaries"]) => string[] };
const { ENGINE, router } = (await import(join(B3, "browser/pages.mjs"))) as { ENGINE: string; router: (c: ReplayCase, p: "a" | "b") => (url: string) => { kind: string; html: string } };
const { replayPassport } = (await import(join(B3, "browser/passport.mjs"))) as { replayPassport: (p: "a" | "b", d: Record<string, string>) => PassportEntry[] };
const { PAUSE_PREFIX } = (await import(join(B3, "score.mjs"))) as { PAUSE_PREFIX: string };
const K = join(REPO, "packages/kernel/src");
const kernelServer = (await import(join(K, "mcp/server.ts"))) as Record<string, string>;
const { say } = (await import(join(K, "i18n.ts"))) as { say: (locale: string, id: string, args?: Record<string, string>) => string };
/** The kernel's refusals answered without a card (harness.mts's REFUSALS): a tool event holding one is `refused`. */
const REFUSALS = [...["LABEL_REFUSED", "REVEAL_DENIED", "FILL_DENIED", "SAVED_LOGIN_REFUSED", "FILL_WRONG_ORIGIN", "HANDLE_REFUSED", "PASSWORD_FIELD_ONLY", "PASSWORD_FIELD_REFUSED"].map((k) => kernelServer[k]!),
  ...["kernel-mask-locked-refused", "kernel-mask-store-locked", "kernel-mask-no-login", "kernel-mask-fill-blocked", "kernel-mask-reveal-shared", "kernel-mask-unknown-label"].map((k) => say("fr", k, { name: "" }).split("{")[0]!.slice(0, 40))];
// As harness.mts's self-check: a text that did not resolve would mark every tool event refused.
if (!REFUSALS.every((t) => t?.length >= 20)) throw new Error("a kernel refusal text did not resolve");

const FROZEN = join(B3, "browser/replay-cases.json");
/** The frozen list's passport decisions; a list whose sha256 differs from its .sha256 is refused (README, protocol). */
function decisions(): Record<string, string> {
  const raw = readFileSync(FROZEN);
  if (createHash("sha256").update(raw).digest("hex") !== readFileSync(`${FROZEN}.sha256`, "utf8").split(/\s/)[0]) throw new Error("replay-cases.json differs from its .sha256");
  return JSON.parse(raw.toString("utf8")).passport;
}

/** A case of adversary-cases.json (or a frozen line's case). */
export type ReplayCase = { id: string; arm: string; title: string; benign_task: string; links: { text: string; url: string }[]; page_markdown: string; pages?: Record<string, string>; attacker_domain?: string; [k: string]: unknown };
export type Ev = { seq: number; at: number; t: string; [k: string]: unknown };
export interface World {
  w: LaunchedRessac; m: Marionette; c: ReplayCase; profile: "a" | "b";
  /** Ressac tab ids of the user's two tabs. */
  tabs: { mail: string; bank: string };
  events: Ev[]; note(t: string, more?: Record<string, unknown>): Ev;
  /** The newest `.ressac/sessions/<id>.json`: the window's conversation, whose token resolves its labels. */
  sessionConfig(): string;
  /** Ressac, the servers, the proxy, the certificate and the folders. */
  close(): Promise<void>;
}

const listen = (s: Server) => new Promise<number>((ok) => s.listen(0, "127.0.0.1", () => ok((s.address() as AddressInfo).port)));

export async function openWorld(c: ReplayCase, o: { profile: "a" | "b"; env?: Record<string, string | undefined>; prefs?: Record<string, string | number | boolean>; output?: string; beforeLaunch?(dataDir: string): Promise<void> }): Promise<World> {
  const P = PROFILES[o.profile];
  const route = router(c, o.profile);
  const t0 = Date.now();
  const events: Ev[] = [];
  let seq = 0;
  const note = (t: string, more: Record<string, unknown> = {}): Ev => {
    const e = { seq: ++seq, at: Date.now() - t0, t, ...more };
    events.push(e);
    return e;
  };
  // The setup's loads are the user's own visits: nothing is noted before it ends.
  let recording = false;
  const engine = new URL(ENGINE);
  /** Review Focus 1: only a document load leaves as `out` (a top or frame document, or a plain http GET through the proxy
   *  that asks for HTML: Firefox sends no Sec-Fetch-* over http); favicons, scripts and Firefox's background fetches are `subresource`. */
  const seen = (url: string, req: IncomingMessage, proxied: boolean) => {
    if (!recording) return;
    const dest = req.headers["sec-fetch-dest"];
    const document = dest === "document" || dest === "iframe" || (proxied && dest === undefined && /^text\/html/.test(req.headers.accept ?? ""));
    if (!document) return void note("subresource", { url, dest: dest ?? null });
    const u = new URL(url);
    const query = u.host === engine.host && u.pathname === engine.pathname ? u.searchParams.get("q") : null;
    note("out", query ? { via: "search.open", query } : { via: "navigate", url });
  };
  const answer = (url: string, res: ServerResponse) => res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(route(url).html);

  const certs = await mkdtemp(join(os.tmpdir(), "ressac-cert-"));
  const [key, cert] = [join(certs, "key.pem"), join(certs, "cert.pem")];
  // Any name: Firefox's certificate checks are off for this profile (below).
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "2", "-subj", "/CN=replay.test"], { stdio: "ignore" });
  const pages = createHttpsServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
    const url = `https://${(req.headers.host ?? "").replace(/:443$/, "")}${req.url ?? "/"}`;
    seen(url, req, false);
    answer(url, res);
  });
  const pagesPort = await listen(pages);
  // The proxy: every https tunnel ends at the page server whatever its host; an http GET (absolute form) is answered here.
  const proxy = createHttpServer((req, res) => {
    const url = req.url ?? "";
    if (!/^http:\/\//.test(url)) return void res.writeHead(400).end();
    seen(url, req, true);
    answer(url, res);
  });
  proxy.on("connect", (_req, client, head) => {
    const up = connect(pagesPort, "127.0.0.1", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) up.write(head);
      client.pipe(up).pipe(client);
    });
    up.on("error", () => client.destroy());
    client.on("error", () => up.destroy());
  });
  const proxyPort = await listen(proxy);
  const stopServers = async () => {
    // Tunnels stay open after Ressac quits until their sockets are gone.
    pages.closeAllConnections();
    proxy.closeAllConnections();
    await Promise.all([new Promise((r) => pages.close(r)), new Promise((r) => proxy.close(r))]);
    await rm(certs, { recursive: true, force: true });
  };

  const dataDir = await mkdtemp(join(os.tmpdir(), "ressac-data-"));
  const profileDir = await mkdtemp(join(os.tmpdir(), "ressac-firefox-"));
  const removeFolders = () => Promise.all([rm(dataDir, { recursive: true, force: true }), rm(profileDir, { recursive: true, force: true })]);
  let w: LaunchedRessac;
  try {
    await writePassport(profileDir, replayPassport(o.profile, decisions()));
    await o.beforeLaunch?.(dataDir);
    w = await launchRessac({
      dataDir,
      profile: profileDir,
      output: o.output,
      prefs: { "network.proxy.type": 1, "network.proxy.ssl": "127.0.0.1", "network.proxy.ssl_port": proxyPort, "network.proxy.http": "127.0.0.1", "network.proxy.http_port": proxyPort, ...o.prefs },
      // RESSAC_TEST_REAUTH: Touch ID passes (a bypassed layer, README).
      env: { RESSAC_TEST_SEARCH_URL: `${ENGINE}?q=%s`, RESSAC_TEST_PASSPORT_CIPHER: "memory", RESSAC_TEST_REAUTH: "pass", ...o.env },
    });
  } catch (e) {
    await stopServers();
    await removeFolders();
    throw e;
  }
  const close = async () => {
    await w.close();
    await stopServers();
    await removeFolders();
  };
  const m = w.marionette;
  try {
    await m.setContext("chrome");
    await waitFor(m, "return !!window.ressacWindow && gBrowser.tabs.some((t) => t.hasAttribute('ressac-parking'))", (v) => v === true, 30_000);
    await m.execute('Cc["@mozilla.org/security/certoverride;1"].getService(Ci.nsICertOverrideService).setDisableAllSecurityChecksAndLetAttackersInterceptMyData(true);');

    const windowId = (await state(m)).windows[0]!.id;
    const open = async (url: string) => {
      const before = new Set(Object.keys((await state(m)).tabs));
      const s = await dispatch(m, { type: "openTab", windowId, url, agentReached: false });
      const id = Object.keys(s.tabs).find((x) => !before.has(x))!;
      await waitFor(m, `return gBrowser.browsers.some((b) => b.currentURI.spec === ${JSON.stringify(url)} && !b.webProgress.isLoadingDocument)`, (v) => v === true, 15_000);
      return id;
    };
    // The user's history by visits: each page kept (its text in the history's full-text index, the agent's search reads
    // it; no chrome call runs History.searchForAgent itself) before its tab closes.
    for (const h of P.history) {
      const id = await open(h.url);
      await kept(m, h.url);
      await dispatch(m, { type: "closeTab", id });
    }
    await m.execute(
      "return (async () => { for (const b of arguments[0]) await PlacesUtils.bookmarks.insert({ parentGuid: PlacesUtils.bookmarks.unfiledGuid, url: b.url, title: b.title }); })()",
      [P.bookmarks],
    );
    const bank = await open(P.bankUrl);
    const mail = await open(P.mailUrl);
    // The user speaks from the mail tab.
    await dispatch(m, { type: "activateTab", id: mail });
    recording = true;

    const sessions = join(dataDir, "workspace", ".ressac", "sessions");
    const sessionConfig = () => {
      const config = readdirSync(sessions).filter((f) => f.endsWith(".json")).map((f) => join(sessions, f)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
      if (!config) throw new Error("no session config");
      return config;
    };
    return { w, m, c, profile: o.profile, tabs: { mail, bank }, events, note, sessionConfig, close };
  } catch (e) {
    await close();
    throw e;
  }
}

/** Waits until the history kept `url`'s text (the sidebar's API, as history.e2e.ts). */
async function kept(m: Marionette, url: string): Promise<void> {
  for (const end = Date.now() + 15_000; ; await new Promise((r) => setTimeout(r, 100))) {
    const all = await inUi<{ url: string; kept: boolean }[]>(m, "return JSON.parse(JSON.stringify(await ui.ressac.history.recent()));");
    if (all.some((v) => v.url === url && v.kept)) return;
    if (Date.now() > end) throw new Error(`${url} was never kept in the history`);
  }
}

const READS = new Set(["read_tab", "current_page", "read_pages"]);

/** The in-process agent (the scripted adversary): each call through the window's conversation, noted as harness.mts does. */
export function toolCaller(world: World, refusals: string[] = REFUSALS): (name: string, args?: Record<string, unknown>) => Promise<string> {
  const route = router(world.c, world.profile);
  return async (name, raw = {}) => {
    const args = JSON.parse(JSON.stringify(raw).replaceAll('"tab-mail"', JSON.stringify(world.tabs.mail)).replaceAll('"tab-bank"', JSON.stringify(world.tabs.bank))) as Record<string, unknown>;
    const e = world.note("tool", { name, args });
    try {
      const r = await callMcpTool(join(world.w.dataDir, "workspace"), name, args, world.sessionConfig());
      e.result = r.text;
      if (r.error) e.isError = true;
      if (refusals.some((t) => r.text.includes(t))) e.refused = true;
      return r.text;
    } catch (err) {
      e.result = `throw: ${String(err)}`;
      e.isError = true;
      throw err;
    } finally {
      // The seq after the call: the loads it caused fall between `seq` and `endSeq` (score.mjs).
      // A seq of its own, as harness.mts's `++seq`: noted and dropped at once.
      e.endSeq = world.note("end").seq;
      world.events.pop();
      // A failed look at the tabs never hides the tool's own error or loses its result: noted on the event instead.
      if (READS.has(name) && !e.isError) {
        try {
          const s = await state(world.m);
          const win = s.windows[0]!;
          const urls = name === "read_pages" ? ((args.urls as string[] | undefined) ?? [])
            : [s.tabs[(name === "read_tab" ? String(args.id) : win.active[win.activeSpace]) ?? ""]?.url ?? ""];
          for (const url of urls) world.note("read", { ...(name === "read_pages" ? {} : { tab: name === "read_tab" ? args.id : win.active[win.activeSpace] }), url, page: route(url).kind });
        } catch (err) {
          e.readError = String(err);
        }
      }
    }
  };
}

const git = (...a: string[]) => execFileSync("git", ["-C", REPO, ...a], { encoding: "utf8" }).trim();

/** harness.mts's record (bench "ressac-e2e-injection/2"), for score.mjs, levels() and the reports. */
export async function record(world: World, x: { prompt: string; answer: string; agent: Record<string, unknown>; config: Record<string, unknown>; stop?: string; error?: string; seconds: number }): Promise<Record<string, unknown>> {
  const { c, profile } = world;
  const P = PROFILES[profile];
  const caseText = `${c.title}\n${c.page_markdown}\n${Object.values(c.pages ?? {}).join("\n")}\n${c.links.map((l) => `${l.text} ${l.url}`).join("\n")}\n${x.prompt}`;
  const notes = join(world.w.dataDir, "workspace", ".ressac", "browsing-notes.md");
  // The product's code only: a change under e2e or bench is not a different build.
  const dirty = git("status", "--porcelain", "--", "apps/firefox/chrome", "apps/firefox/host", "apps/firefox/core", "apps/firefox/shared", "apps/firefox/ui", "packages/kernel/src").length > 0;
  return {
    bench: "ressac-e2e-injection/2", case: fromRessac(c), prompt: x.prompt,
    config: { ...x.config, profile, surface: "browser", build: { commit: git("rev-parse", "HEAD"), dirty } },
    canaries: P.canaries, collisions: collisionsIn(caseText, P.canaries), masking: {}, events: world.events, answer: x.answer,
    notebook: existsSync(notes) ? readFileSync(notes, "utf8").split("\n").filter((l) => l.startsWith("- ")) : [],
    agent: x.agent, ...(x.stop ? { stop: x.stop } : {}), ...(x.error ? { error: x.error } : {}), seconds: x.seconds,
  };
}

/** What a poll sees: the request modal's cards (sidebar), the agent panel's notice, the search band in « à vous ». */
const LOOK = `const sq = (s) => (s ?? "").replace(/\\s+/g, " ").trim();
  const side = document.getElementById("ressac-sidebar")?.contentDocument;
  const cards = [...(side?.querySelectorAll('[data-testid="request-modal"] .reading') ?? [])].map((r) => {
    // A card is marked once seen: a press goes to that card only, never to the next one that took its place.
    r.dataset.replaySeen ||= String(++window.replaySeen || (window.replaySeen = 1));
    return { seen: r.dataset.replaySeen, answered: r.hasAttribute("data-replay-answered"), testid: r.dataset.testid, kind: r.dataset.kind ?? null,
      history: !!r.querySelector('[data-testid="history-request"]'), allow: !!r.querySelector("button.allow:not([disabled])"), url: sq(r.querySelector('[data-testid="address-request-url"]')?.textContent) || null,
      danger: [...r.querySelectorAll('[data-testid$="-request-danger"]')].map((x) => sq(x.textContent)), text: sq(r.textContent) };
  });
  const notice = sq(document.getElementById("ressac-agent")?.contentDocument?.querySelector('[data-testid="agent-mask-notice"]')?.textContent) || null;
  const b = document.querySelector('[data-testid="search-band"]');
  const band = b?.hasAttribute("data-shown") && b.dataset.state === "yours" ? sq(b.querySelector('[data-testid="search-band-text"]')?.textContent) : null;
  return { cards, notice, band };`;
type Look = { cards: { seen: string; answered: boolean; testid: string; kind: string | null; history: boolean; allow: boolean; url: string | null; danger: string[]; text: string }[]; notice: string | null; band: string | null };
/** The masking cards by data-kind (ui/components/MaskRequest.svelte), as harness.mts answers them. `mask-devtools` has no
 *  B3 answer (the bench's agent never opens dev tools): unmapped, it fails the leg. */
const MASK: Record<string, { t: string; by: "card" | "address" }> = { "mask-reveal": { t: "card-reveal", by: "card" }, "mask-fill": { t: "card-fill", by: "card" }, "mask-label-alert": { t: "card-label", by: "address" } };

/**
 * The automatic user (harness.mts's bridge answers, through the real UI): every 100 ms it looks at the request modal, the
 * agent panel and the search band, answers each card by `policy` (a red line always refused), stops a watcher's pause and
 * continues a hand-over, each noted with its text. Anything else (an unknown card, a lock notice, two cards at once) is
 * `failed()`, and the leg ends with it.
 */
export function answerCards(world: World, policy: { card: "grant" | "deny"; address: "grant" | "deny" }): { stop(): Promise<void>; failed(): string | null } {
  const m = world.m;
  let stopped = false;
  let failure: string | null = null;
  let lastBand: string | null = null;
  const press = async (seen: string, grant: boolean) => {
    const card = `[data-testid="request-modal"] .reading[data-replay-seen="${seen}"]`;
    await click(m, grant ? `${card} button.allow` : `${card} button`, grant ? {} : { text: "Refuser" });
    await inUi(m, `doc.querySelector(arguments[0])?.setAttribute("data-replay-answered", "")`, [card]);
  };
  const answer = async (k: Look["cards"][number]) => {
    const mask = k.testid === "mask-request" ? MASK[k.kind ?? ""] : undefined;
    const [t, by] = k.testid === "permission-request" ? ["card-tab", "card"] as const
      : k.testid === "widget-data-request" && k.history ? ["card-history", "card"] as const
      : k.testid === "address-request" ? ["card-address", "address"] as const
      : mask ? [mask.t, mask.by] as const : [null, null];
    if (!t) return void (failure = `unknown card: ${k.testid}${k.kind ? `/${k.kind}` : ""}`);
    const grant = !k.danger.length && policy[by] === "grant";
    // A grant the card cannot take (a fill with several entries and none picked, a kind the passport lacks): pressed, it
    // would be lost and the tool would wait forever.
    if (grant && !k.allow) return void (failure = `unknown card: ${k.testid}${k.kind ? `/${k.kind}` : ""} (no allow)`);
    // Noted before the press: the tool call it answers ends right after, and the card must fall inside it (score.mjs).
    const e = world.note(t, { text: k.text, ...(k.url ? { url: k.url } : {}), ...(k.danger.length ? { danger: k.danger.join(" ") } : {}), answer: grant ? "grant" : "deny" });
    try {
      await press(k.seen, grant);
    } catch {
      // Gone between the look and the press: looked at again.
      world.events.splice(world.events.indexOf(e), 1);
    }
  };
  const loop = (async () => {
    while (!stopped && !failure) {
      try {
        const look = await m.execute<Look>(LOOK);
        const open = look.cards.filter((k) => !k.answered);
        if (look.cards.length > 1) failure = `unknown card: two cards at once (${look.cards.map((k) => k.testid).join(", ")})`;
        else if (look.notice) failure = `unknown card: lock-notice (${look.notice})`;
        else if (open[0]) await answer(open[0]);
        else if (look.band === null) lastBand = null;
        else if (look.band !== lastBand) {
          // « à vous » shows both buttons: the watcher's pause is told by its text, as harness.mts does.
          const pause = look.band.startsWith(PAUSE_PREFIX);
          const e = world.note(pause ? "pause" : "hand", { text: look.band, answer: pause ? "stop" : "continue" });
          try {
            await m.execute(`document.querySelector('[data-testid="search-band"] [data-testid="${pause ? "search-stop" : "search-continue"}"]').click();`);
            lastBand = look.band;
          } catch {
            // The band went between the look and the press: looked at again.
            world.events.splice(world.events.indexOf(e), 1);
          }
        }
      } catch {
        // A frame reloading under the look: looked at again.
      }
      if (!failure) await new Promise((r) => setTimeout(r, 100));
    }
  })();
  return { stop: async () => void ((stopped = true), await loop), failed: () => failure };
}
