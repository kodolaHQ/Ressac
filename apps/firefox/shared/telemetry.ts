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
    platform: "javascript",
    tags: { source: e.source },
    exception: { values: [{ type: s(e.type), value: s(e.message).replace(QUOTED, '"…"').slice(0, 300), stacktrace: { frames } }] },
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
