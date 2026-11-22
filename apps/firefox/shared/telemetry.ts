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

// Every scheme but Ressac's own code (chrome://, resource://, moz-src://), which helps debugging and names nothing private.
const PRIVATE_URL = /(?<![a-z0-9+.-])(?!(?:chrome|resource|moz-src):)(?:[a-z][a-z0-9+.-]*:\/\/|blob:|data:|mailto:|about:reader\?)[^\s)'"<>]+/gi;
// The rest of a path, spaces included (« Espace Banque/projet/app.js »), up to a quote, a bracket or the line's end:
// hiding a few words too many is fine, a folder name is not.
const TAIL = String.raw`[^\n)'"<>]*`;
// Folders of the Mac other than the home (another account, an external disk), and a path written from the home.
const OTHER_PATH = new RegExp(String.raw`(?<![\w.-])(?:/(?:Users|Volumes|tmp|private|var)/|~/)` + TAIL, "g");
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function scrub(text: string, home: string): string {
  const h = home.replace(/\/+$/, "");
  let t = text.normalize("NFC");
  if (h) {
    // The home in any case and accent form (both sides composed), slashes JSON-escaped or not; only at a path boundary
    // (/Users/marieX is someone else's folder). What follows it names the user's folders and files: it goes too.
    // A slash may also be percent-encoded (an address that carries the path).
    const slash = String.raw`(?:\\?/|%2f)`;
    const form = escape(h.normalize("NFC")).replace(/\//g, slash);
    t = t.replace(new RegExp(`${form}(?![\\w.-])(${slash}${TAIL})?`, "giu"), (_, rest) => (rest ? "~/…" : "~"));
  }
  return t.replace(OTHER_PATH, (p) => (p.startsWith("~/") ? "~/…" : "<path>")).replace(PRIVATE_URL, "<url>");
}

// A message may quote what it choked on (JSON.parse, a path, typed text): no quoted span leaves. A single quote opens a
// quote only after a non-letter: « d'ouvrir 'contrat.pdf' » quotes the file name, not « ouvrir ».
const QUOTED = /"[^"\n]*?"|(?<![\p{L}\d])'[^'\n]*?'|`[^`\n]*?`|«[^»\n]*?»|“[^”\n]*?”|‘[^’\n]*?’/gu;
// In a message only (frames keep their file and function names): e-mails, IPs, and names with a dot (a host, a file).
// Each pattern starts only at a word's start: a match tried from every position of a long word is quadratic.
const EMAIL = /(?<![\w.+-])[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
// IPv6 bare: with « :: » or at least four colons, so a time (12:30:45) stays.
const IP = /\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b|\[[0-9a-f:.]+\](?::\d+)?|(?<![\w:])(?=[0-9a-f:]*::|(?:[0-9a-f]{1,4}:){4})[0-9a-f:]{2,39}(?:%\w+)?(?![\w:])/gi;
// A host by its last label, or by a port or path after it: « this.tabs is undefined » keeps the code name it is about.
const TLD = "com|net|org|fr|io|dev|app|co|me|info|eu|de|uk|be|ch|ca|us|es|it|nl|example|test|local|internal|lan|home|corp";
const HOST = new RegExp(String.raw`(?<![\w/.:@~<-])(?:[a-z0-9-]+\.)+(?:(?:${TLD})(?![\w-])|[a-z][a-z0-9-]*(?=[:/]))(?::\d+)?(?:/[^\s)'"<>]*)?`, "gi");
// 300 characters are sent: the rest need not be scrubbed (a huge message would cost the chrome thread).
const message = (t: string, home: string) => scrub(t.slice(0, 4000), home).replace(EMAIL, "<email>").replace(IP, "<ip>").replace(HOST, "<host>").replace(QUOTED, '"…"');

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
    exception: { values: [{ type: message(e.type, o.home), value: message(e.message, o.home).slice(0, 300), ...(frames.length ? { stacktrace: { frames } } : {}) }] },
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
