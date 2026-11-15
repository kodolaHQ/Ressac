/** Anonymous Sentry error reports. Pure: runs in vitest and in the Firefox chrome (no Node or chrome API). */

export type ReportedError = { source: "chrome" | "host"; type: string; message: string; stack?: string };
type Frame = { function: string; filename: string; lineno: number; colno: number };

export function parseDsn(dsn: string): { envelopeUrl: string; minidumpUrl: string } | null {
  const m = /^(https?):\/\/([^@/\s]+)@([^/\s]+)\/(\d+)$/.exec(dsn);
  if (!m) return null;
  const [, scheme, key, host, project] = m;
  const base = `${scheme}://${host}/api/${project}`;
  return {
    envelopeUrl: `${base}/envelope/?sentry_key=${key}&sentry_version=7`,
    minidumpUrl: `${base}/minidump/?sentry_key=${key}`,
  };
}

// chrome:// and resource:// are not listed: they stay.
const PRIVATE_URL = /\b(?:(?:https?|wss?|file):\/\/|blob:|data:)[^\s)'"<>]+/gi;

export function scrub(text: string, home: string): string {
  const t = text.replace(PRIVATE_URL, "<url>");
  const h = home.replace(/\/+$/, "");
  // Only at a path boundary: /Users/marieX is someone else's folder.
  return h ? t.replace(new RegExp(h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?![\\w.-])", "g"), "~") : t;
}

// A message may name a site without a scheme (« Navigation bloquée : intranet.boite.fr »). Code file names stay.
const BARE_HOST = /\b(?:[a-z0-9-]+\.)+([a-z]{2,})\b/gi;
const CODE_FILE = new Set(["js", "mjs", "cjs", "ts", "svelte", "json", "html", "css", "ftl", "sqlite", "md", "txt", "log", "sys", "jsm"]);
const scrubHosts = (t: string) => t.replace(BARE_HOST, (m, last: string) => (CODE_FILE.has(last.toLowerCase()) ? m : "<host>"));

// A message may quote what it choked on (JSON.parse, a path, typed text): no quoted span leaves.
const QUOTED = /"[^"\n]*?"|'[^'\n]*?'|`[^`\n]*?`|«[^»\n]*?»/g;

const V8 = /^\s*at (?:(.*?) \()?(.*?):(\d+):(\d+)\)?\s*$/;
const SPIDER = /^(.*?)@(.*?):(\d+):(\d+)\s*$/;

export function parseStack(stack: string): Frame[] {
  const frames: Frame[] = [];
  for (const line of stack.split("\n")) {
    const m = V8.exec(line) ?? SPIDER.exec(line);
    if (m) frames.push({ function: m[1] || "?", filename: m[2]!, lineno: +m[3]!, colno: +m[4]! });
  }
  return frames.reverse();
}

export function errorEnvelope(e: ReportedError, o: { release: string; home: string; eventId: string; now: Date }): string {
  const s = (t: string) => scrub(t, o.home);
  // The 50 most recent frames (parseStack puts them last), a 300-char value.
  const frames = parseStack(e.stack ?? "").slice(-50).map((f) => ({ ...f, filename: s(f.filename), function: s(f.function) }));
  const event = {
    event_id: o.eventId,
    timestamp: o.now.toISOString(),
    release: o.release,
    environment: "beta",
    platform: "node",
    // Without this, Sentry derives the sender's IP (and so a city) from the request.
    sdk: { name: "ressac", version: o.release, settings: { infer_ip: "never" } },
    // An explicit, unlocatable IP: Sentry keeps it instead of the sender's, so it derives no city.
    user: { ip_address: "0.0.0.0" },
    tags: { source: e.source },
    exception: { values: [{ type: s(e.type), value: scrubHosts(s(e.message).replace(QUOTED, '"…"')).slice(0, 300), ...(frames.length ? { stacktrace: { frames } } : {}) }] },
  };
  return [{ event_id: o.eventId, sent_at: o.now.toISOString() }, { type: "event" }, event].map((x) => JSON.stringify(x)).join("\n");
}

export function createReporter(o: {
  dsn: string;
  release: string;
  home: string;
  enabled: () => boolean;
  post: (url: string, body: string) => Promise<unknown>;
  max?: number;
}): { report(e: ReportedError): void } {
  const urls = parseDsn(o.dsn);
  const seen = new Set<string>();
  const max = o.max ?? 30;
  return {
    report(e) {
      try {
        if (!urls || !o.enabled() || seen.size >= max) return;
        const key = `${e.source}|${scrub(e.type, o.home)}|${scrub(e.message, o.home)}`;
        if (seen.has(key)) return;
        seen.add(key);
        // The event id is derived here (no crypto in a pure module): 32 hex chars.
        const eventId = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
        const body = errorEnvelope(e, { release: o.release, home: o.home, eventId, now: new Date() });
        Promise.resolve(o.post(urls.envelopeUrl, body)).catch(() => {});
      } catch {}
    },
  };
}

/** One anonymous session per launch: lets Sentry count installs (`did`) and launches. No home path, no URL. */
export function sessionEnvelope(o: { release: string; installId: string; sessionId: string; now: Date }): string {
  const t = o.now.toISOString();
  const session = {
    sid: o.sessionId, did: o.installId, init: true, started: t, timestamp: t, status: "exited", duration: 0, errors: 0,
    // Same unlocatable IP as the error events: Sentry derives no city.
    attrs: { release: o.release, environment: "beta", ip_address: "0.0.0.0" },
  };
  return [{ sent_at: t }, { type: "session" }, session].map((x) => JSON.stringify(x)).join("\n");
}

// shortcut: one "exited" session per launch, no live session or crash linking; enough to count installs and launches, upgrade if crash-free rates matter
export function launchSession(o: {
  dsn: string;
  release: string;
  enabled: () => boolean;
  post: (url: string, body: string) => Promise<unknown>;
  ids: { get(): string | undefined; set(id: string): void; clear(): void };
  newId: () => string;
}): void {
  try {
    const urls = parseDsn(o.dsn);
    if (!urls) return;
    // Reports off: the install id goes away, so turning them back on starts a new one.
    if (!o.enabled()) return o.ids.clear();
    let installId = o.ids.get();
    if (!installId) o.ids.set((installId = o.newId()));
    const body = sessionEnvelope({ release: o.release, installId, sessionId: o.newId(), now: new Date() });
    Promise.resolve(o.post(urls.envelopeUrl, body)).catch(() => {});
  } catch {}
}
