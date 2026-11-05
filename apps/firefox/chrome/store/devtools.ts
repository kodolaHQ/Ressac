import { origineDe } from "../../../navigateur/src/main/agent/pont";
import { TEXTE_REVOQUE } from "../../../navigateur/src/main/outils-dev/inspecteur";
import { TamponOnglet, textePile } from "../../../navigateur/src/main/outils-dev/tampon";
import { OngletIntrouvable, OngletPrive, type OutilsDevNavigateur, type RequeteReseau, type ResultatJs } from "../shims/noyau";
import type { Store } from "./store";
import type { WindowRegistry } from "./windows";

// The agent's dev tools on a tab, the Firefox side of the noyau's OutilsDevNavigateur (plan 28, note D1-D4, D7-D9): an
// in-process DevTools client per tab (CommandsFactory.forTab over DevToolsServer.connectPipe, the toolbox's own way), no
// socket and no listener. It coexists with the person's own toolbox on the same tab (note D7): OutilsDevOccupes is never raised.

/** Electron's TamponOnglet bound for the network (its console keeps 1000 messages, truncated by the noyau's tronquer). */
const MAX_REQUESTS = 500;
/** As Electron's DELAI_NAVIGATION_MS: a reload, or the new top-level target after a navigation. */
const NAVIGATION_TIMEOUT_MS = 10_000;
/** A running script cannot be stopped (note D3b): the call answers after this, its late result is dropped. */
const EVAL_TIMEOUT_MS = 10_000;
const PROMISE_POLL_MS = 50;
/** The noyau truncates a body at 2000 characters: no need to carry more. */
const BODY_MAX = 100_000;
const TRUNCATED = "… [tronqué]";
const EXTENSION = "moz-extension://";
export const TEXTE_DELAI = `Le code n'a pas répondu en ${EVAL_TIMEOUT_MS / 1000} s : son résultat sera ignoré.`;
const TEXTE_SITE_CHANGE = "L'onglet a changé de site.";

export interface DevTools {
  /** One owner per noyau start: creating one revokes the previous (its calls throw TEXTE_REVOQUE, its attachments drop). */
  owner(): { token: string };
  /** Revokes that owner (the current one when no token is given: its host is gone). */
  release(token?: string): void;
  call(token: string, method: keyof OutilsDevNavigateur, args: unknown[], signal?: AbortSignal): Promise<unknown>;
  /** The tabs attached now (tests). */
  attached(): string[];
}

interface Session {
  commands: any;
  buffer: TamponOnglet;
  /** Network resources by id, oldest first: Firefox updates them in place (status, timings, sizes). */
  requests: Map<string, any>;
  /** Headers asked once a request is over. */
  headers: Map<string, { req: Record<string, string>; res: Record<string, string> }>;
  /** The page's origin at attachment: a navigation elsewhere drops the session. */
  origin: string | null;
  /** The next top-level target: each navigation brings one, and the previous is destroyed (note D1). */
  nextTarget: Promise<any>;
  dropped: boolean;
}

let loader: any;
const devtoolsRequire = (id: string) => (loader ??= ChromeUtils.importESModule("resource://devtools/shared/loader/Loader.sys.mjs")).require(id);
let parser: any;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const grip = (g: any) => (g && typeof g.getGrip === "function" ? g.getGrip() : g);

/** A grip as text, as Electron's texteObjet: a string as is, an Error by its message, another object by its class. */
function gripText(value: any): string {
  const g = grip(value);
  if (g === null || typeof g !== "object") return String(g);
  switch (g.type) {
    case "undefined":
    case "null":
    case "NaN":
    case "Infinity":
    case "-Infinity":
    case "-0":
      return g.type;
    case "BigInt":
      return `${g.text}n`;
    case "longString":
      return g.initial + TRUNCATED;
    case "symbol":
      return `Symbol(${g.name ?? ""})`;
  }
  const p = g.preview;
  if (p?.kind === "Error") return `${p.name ?? g.class}: ${gripText(p.message)}`;
  return String(g.class ?? g.type ?? "");
}

type Frame = { functionName?: string; filename?: string; lineNumber?: number; columnNumber?: number };
/** Firefox's frames (1-based) as the protocol's call frames (0-based) that Electron's textePile writes. */
const callFrames = (frames: Frame[] | null | undefined) => ({
  callFrames: (frames ?? []).map((f) => ({ functionName: f.functionName ?? "", url: f.filename ?? "", lineNumber: (f.lineNumber ?? 1) - 1, columnNumber: (f.columnNumber ?? 1) - 1 })),
});
/** An Error's `stack` (one "name@url:line:col" per line) as call frames. */
const stackFrames = (stack: unknown) => ({
  callFrames: String(stack ?? "")
    .split("\n")
    .map((l) => /^(.*)@(.*):(\d+):(\d+)$/.exec(l))
    .filter((m) => m !== null)
    .map((m) => ({ functionName: m[1]!, url: m[2]!, lineNumber: Number(m[3]) - 1, columnNumber: Number(m[4]) - 1 })),
});
const withStack = (message: string, frames: ReturnType<typeof callFrames>) => {
  const pile = textePile(frames);
  return pile && !message.includes("\n    at ") ? `${message}\n${pile}` : message;
};

/** An extension's content script writes in the tab's console (note D1): never the page's. */
const fromExtension = (file: unknown, frames: Frame[] | null | undefined) =>
  String(file ?? "").startsWith(EXTENSION) || !!frames?.some((f) => f.filename?.startsWith(EXTENSION));

/** A console or error resource into Electron's buffer, as the protocol's events it reads. */
function feedConsole(buffer: TamponOnglet, r: any, TYPES: any): void {
  if (r.resourceType === TYPES.CONSOLE_MESSAGE) {
    if (fromExtension(r.filename, r.stacktrace)) return;
    buffer.evenement("Runtime.consoleAPICalled", {
      type: r.level === "warn" ? "warning" : r.level,
      args: (r.arguments ?? []).map((a: unknown) => ({ value: gripText(a) })),
      timestamp: r.timeStamp,
      stackTrace: callFrames(r.stacktrace),
    });
    return;
  }
  const e = r.pageError;
  if (!e || fromExtension(e.sourceName, e.stacktrace)) return;
  const text = gripText(e.errorMessage).replace(/^uncaught exception: /, "");
  // A rejection's stack is not in `stacktrace` but in its exception (note D1).
  const stack = e.stacktrace?.length ? callFrames(e.stacktrace) : stackFrames(grip(e.exception)?.preview?.stack);
  if (e.warning || e.info) buffer.evenement("Log.entryAdded", { entry: { level: e.warning ? "warning" : "info", text, timestamp: e.timeStamp, stackTrace: stack } });
  else
    buffer.evenement("Runtime.exceptionThrown", {
      timestamp: e.timeStamp,
      exceptionDetails: { text: e.isPromiseRejection ? "Uncaught (in promise)" : "Uncaught", exception: { description: text }, stackTrace: stack },
    });
}

const headerRecord = (r: any): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const h of r?.headers ?? []) {
    const v = typeof h.value === "string" ? h.value : gripText(h.value);
    out[h.name] = out[h.name] === undefined ? v : `${out[h.name]}\n${v}`;
  }
  return out;
};

function requestOf(r: any, h: { req: Record<string, string>; res: Record<string, string> } | undefined): RequeteReseau {
  return {
    id: String(r.resourceId),
    horodatage: r.timeStamp ?? Date.now(),
    methode: r.method ?? "GET",
    url: r.url ?? "",
    // Firefox gives the status as a string (note D2).
    ...(r.status ? { statut: Number(r.status) } : {}),
    ...(typeof r.totalTime === "number" ? { dureeMs: r.totalTime } : {}),
    ...(typeof r.transferredSize === "number" ? { taille: r.transferredSize } : {}),
    ...(r.cause?.type ? { type: r.cause.type } : {}),
    enTetesRequete: { ...h?.req },
    enTetesReponse: { ...h?.res },
    ...(r.blockedReason ? { erreur: String(r.blockedReason) } : {}),
  };
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Interrompu.", "AbortError");
}

export function createDevTools(o: { store: Store; windows: WindowRegistry; isPrivate(tabId: string): boolean }): DevTools {
  const entries = new Map<string, { browser: any; session: Promise<Session> }>();
  let current: string | null = null;

  const drop = (id: string) => {
    const e = entries.get(id);
    if (!e) return;
    entries.delete(id);
    void e.session.then(
      (s) => {
        s.dropped = true;
        s.buffer.vider();
        s.requests.clear();
        s.headers.clear();
        return s.commands.destroy();
      },
      () => {},
    ).catch(() => {});
  };
  const dropAll = () => [...entries.keys()].forEach(drop);

  // A tab closed or turned private: detached at once, its buffers emptied.
  o.store.subscribe((state) => {
    for (const id of [...entries.keys()]) if (!state.onglets[id] || o.isPrivate(id)) drop(id);
  });

  async function attach(win: any, browser: any, dropMe: () => void): Promise<Session> {
    const tab = win.gBrowser.getTabForBrowser(browser);
    if (!tab) throw new Error("L'onglet n'a pas de page.");
    const { CommandsFactory } = devtoolsRequire("devtools/shared/commands/commands-factory");
    const commands = await CommandsFactory.forTab(tab);
    let resolveNext: (t: any) => void = () => {};
    const s: Session = {
      commands,
      buffer: new TamponOnglet(),
      requests: new Map(),
      headers: new Map(),
      origin: origineDe(browser.currentURI.spec),
      nextTarget: new Promise((r) => (resolveNext = r)),
      dropped: false,
    };
    try {
      const { targetCommand, resourceCommand } = commands;
      await targetCommand.startListening();
      await targetCommand.watchTargets({
        types: [targetCommand.TYPES.FRAME],
        onAvailable: ({ targetFront }: any) => {
          if (!targetFront.isTopLevel) return;
          const resolve = resolveNext;
          s.nextTarget = new Promise((r) => (resolveNext = r));
          resolve(targetFront);
        },
      });
      const { TYPES } = resourceCommand;
      // ignoreExistingResources: only what happens after the attachment, as Electron.
      await resourceCommand.watchResources([TYPES.CONSOLE_MESSAGE, TYPES.ERROR_MESSAGE, TYPES.NETWORK_EVENT, TYPES.DOCUMENT_EVENT], {
        ignoreExistingResources: true,
        onAvailable: (list: any[]) => {
          for (const r of list) {
            if (s.dropped) return;
            if (r.resourceType === TYPES.DOCUMENT_EVENT) {
              if (r.name !== "will-navigate" || r.targetFront?.isTopLevel === false) continue;
              // Same site: the messages stay, marked. Another site: they are worth nothing, the session goes.
              if (origineDe(String(r.newURI ?? "")) === s.origin) s.buffer.rechargement();
              else return dropMe();
            } else if (r.resourceType === TYPES.NETWORK_EVENT) {
              if (String(r.url ?? "").startsWith(EXTENSION)) continue;
              const id = String(r.resourceId);
              s.requests.set(id, r);
              if (s.requests.size > MAX_REQUESTS) {
                const oldest = s.requests.keys().next().value!;
                s.requests.delete(oldest);
                s.headers.delete(oldest);
              }
            } else feedConsole(s.buffer, r, TYPES);
          }
        },
      });
    } catch (e) {
      void commands.destroy().catch(() => {});
      throw e;
    }
    return s;
  }

  /** The tab's session, attached if needed. A private tab is refused before any DevTools client is made for it. */
  async function session(id: string): Promise<Session> {
    const check = () => {
      if (!o.store.state.onglets[id]) {
        drop(id);
        throw new OngletIntrouvable(id);
      }
      if (o.isPrivate(id)) {
        drop(id);
        throw new OngletPrive(id);
      }
    };
    check();
    const win = o.windows.get(o.store.state.onglets[id]!.fenetreId);
    if (!win) throw new OngletIntrouvable(id);
    const browser = await win.controller.ensure(id);
    check(); // closed or turned private while it loaded
    let e = entries.get(id);
    // Moved to another window: another browser.
    if (e && e.browser !== browser) {
      drop(id);
      e = undefined;
    }
    if (!e) {
      const entry: { browser: any; session: Promise<Session> } = {
        browser,
        session: attach(win.window, browser, () => {
          if (entries.get(id) === entry) drop(id);
        }),
      };
      entry.session.catch(() => {
        if (entries.get(id) === entry) entries.delete(id);
      });
      entries.set(id, (e = entry));
    }
    return e.session;
  }

  /** The live top-level target: after a navigation, the new one (note D1: "Target already destroyed" otherwise). */
  async function top(s: Session): Promise<any> {
    const t = s.commands.targetCommand.targetFront;
    if (t && !t.isDestroyed()) return t;
    return Promise.race([s.nextTarget, sleep(NAVIGATION_TIMEOUT_MS).then(() => Promise.reject(new Error("La page ne répond pas.")))]);
  }

  /** Evaluates in the page's main world, top frame; once again on a target destroyed by a navigation (the code did not run). */
  async function run(s: Session, expression: string, extra: object = {}): Promise<any> {
    for (let retry = true; ; retry = false) {
      const target = await top(s);
      try {
        return await s.commands.scriptCommand.execute(expression, { selectedTargetFront: target, ...extra });
      } catch (e) {
        if (!retry || !/destroyed/i.test(String((e as Error)?.message ?? e))) throw e;
      }
    }
  }

  /** The value as Electron gives it: JSON when it has one, read once more through `_self` (the code ran once), else a preview. */
  async function valueText(s: Session, value: any): Promise<string> {
    const g = grip(value);
    if (g === null || typeof g !== "object") return JSON.stringify(g) ?? String(g);
    if (g.type === "longString") return JSON.stringify(g.initial) + TRUNCATED;
    if (!g.actor || g.preview?.kind === "DOMNode") return gripText(g);
    const j = await run(s, "JSON.stringify(_self)", { selectedObjectActor: g.actor }).catch(() => null);
    const jg = grip(j?.result);
    if (typeof jg === "string") return jg;
    if (jg?.type === "longString") return jg.initial + TRUNCATED;
    return gripText(g);
  }

  async function evaluate(s: Session, code: string, stop: AbortSignal): Promise<ResultatJs> {
    let expression = code;
    // Top-level await, as the console maps it (the debugger's parser): the code becomes an async function's call.
    if (code.includes("await")) {
      parser ??= new (devtoolsRequire("devtools/client/debugger/src/workers/parser/index").ParserDispatcher)();
      const m = await parser.mapExpression(code, null, null, false, true).catch(() => null);
      if (m?.mapped?.await) expression = m.expression;
    }
    const r = await run(s, expression);
    if (r.exceptionMessage != null || r.exception != null) return { exception: withStack(gripText(r.exceptionMessage ?? r.exception), callFrames(r.exceptionStack)) };
    let value = r.result;
    // A promise is awaited by polling its state, so a rejection keeps its stack (an awaited one comes back without: note D3).
    if (grip(value)?.class === "Promise") {
      for (;;) {
        if (stop.aborted) throw abortError(stop);
        const { promiseState: p } = await value.getPromiseState();
        if (p.state === "rejected") return { exception: withStack(gripText(p.reason), stackFrames(grip(p.reason)?.preview?.stack)) };
        if (p.state === "fulfilled") {
          value = p.value;
          break;
        }
        await sleep(PROMISE_POLL_MS);
      }
    }
    return { valeur: await valueText(s, value) };
  }

  const impl = {
    attacher: async (id: string) => void (await session(id)),
    detacher: async (id: string) => drop(id),
    console: async (id: string) => (await session(id)).buffer.console(),
    async reseau(id: string): Promise<RequeteReseau[]> {
      const s = await session(id);
      const ask = (r: any, type: string) => s.commands.client.request({ to: r.actor, type });
      // Asked once the request is over; a request of a page left behind may have lost its actor (empty then).
      await Promise.all(
        [...s.requests.entries()]
          .filter(([key, r]) => !s.headers.has(key) && (r.status || r.blockedReason))
          .map(async ([key, r]) => {
            const [req, res] = await Promise.allSettled([ask(r, "getRequestHeaders"), ask(r, "getResponseHeaders")]);
            s.headers.set(key, { req: headerRecord(req.status === "fulfilled" ? req.value : null), res: headerRecord(res.status === "fulfilled" ? res.value : null) });
          }),
      );
      return [...s.requests.entries()].map(([key, r]) => requestOf(r, s.headers.get(key)));
    },
    async corps(id: string, requete: string) {
      const s = await session(id);
      const r = s.requests.get(String(requete));
      if (!r) throw new Error(`Requête introuvable : ${requete}`);
      const { content } = await s.commands.client.request({ to: r.actor, type: "getResponseContent" });
      let text = content?.text;
      if (text && typeof text === "object" && text.type === "longString")
        text = (await s.commands.client.request({ to: text.actor, type: "substring", start: 0, end: Math.min(text.length, BODY_MAX) })).substring;
      return { corps: String(text ?? ""), base64: content?.encoding === "base64" };
    },
    async executer(id: string, code: string, signal?: AbortSignal): Promise<ResultatJs> {
      if (signal?.aborted) throw abortError(signal);
      const s = await session(id);
      const stop = new AbortController();
      const work = evaluate(s, String(code), stop.signal);
      work.catch(() => {}); // a late result is dropped
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onAbort = () => {};
      try {
        const r = await Promise.race([
          work,
          new Promise<never>((_, ko) => {
            timer = setTimeout(() => ko(new Error(TEXTE_DELAI)), EVAL_TIMEOUT_MS);
            onAbort = () => ko(abortError(signal!));
            signal?.addEventListener("abort", onAbort, { once: true });
          }),
        ]);
        // The code may have taken the page to another site: its answer is not worth anything there.
        if (s.dropped && origineDe(String(o.store.state.onglets[id]?.url ?? "")) !== s.origin) throw new Error(TEXTE_SITE_CHANGE);
        return r;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        stop.abort();
      }
    },
    async recharger(id: string, sansCache: boolean): Promise<void> {
      const s = await session(id);
      // Resolves at dom-complete (note D4); a page that never finishes still answers, as Electron's.
      await Promise.race([s.commands.targetCommand.reloadTopLevelTarget(!!sansCache), sleep(NAVIGATION_TIMEOUT_MS)]);
      if (s.dropped && origineDe(String(o.store.state.onglets[id]?.url ?? "")) !== s.origin) throw new Error(TEXTE_SITE_CHANGE);
    },
  };

  return {
    owner() {
      current = crypto.randomUUID();
      dropAll();
      return { token: current };
    },
    release(token) {
      if (token !== undefined && token !== current) return;
      current = null;
      dropAll();
    },
    async call(token, method, args, signal) {
      if (token !== current) throw new Error(TEXTE_REVOQUE);
      if (!Object.hasOwn(impl, method) || !Array.isArray(args)) throw new Error(`Pas encore disponible dans WebAiOs-Firefox : ${String(method)}`);
      const r = await (impl as Record<string, (...a: unknown[]) => Promise<unknown>>)[method]!(...args, signal);
      if (token !== current) {
        // An attachment that ended after the revocation is undone.
        if (method === "attacher") drop(String(args[0]));
        throw new Error(TEXTE_REVOQUE);
      }
      return r;
    },
    attached: () => [...entries.keys()],
  };
}
