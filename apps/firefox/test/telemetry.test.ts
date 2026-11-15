import { describe, expect, it } from "vitest";
import { createReporter, errorEnvelope, launchSession, parseDsn, parseStack, scrub, sessionEnvelope } from "../shared/telemetry";

const home = "/Users/marie";

describe("parseDsn", () => {
  it("builds the envelope and minidump urls", () => {
    expect(parseDsn("https://abc@o1.ingest.sentry.io/42")).toEqual({
      envelopeUrl: "https://o1.ingest.sentry.io/api/42/envelope/?sentry_key=abc&sentry_version=7",
      minidumpUrl: "https://o1.ingest.sentry.io/api/42/minidump/?sentry_key=abc",
    });
    expect(parseDsn("http://k@localhost:9000/1")?.envelopeUrl).toBe("http://localhost:9000/api/1/envelope/?sentry_key=k&sentry_version=7");
  });
  it("rejects empty and invalid", () => {
    expect(parseDsn("")).toBeNull();
    expect(parseDsn("pas un dsn")).toBeNull();
  });
});

describe("scrub", () => {
  it("replaces home and web urls", () => {
    expect(scrub("ENOENT /Users/marie/Ressac/x and https://banque.fr/compte?id=3", home)).toBe("ENOENT ~/Ressac/x and <url>");
  });
  it("hides every private scheme but keeps chrome and resource", () => {
    for (const u of ["file:///Users/marie/a", "wss://x", "blob:https://a/b", "data:text/html,hi"]) expect(scrub(u, home)).toBe("<url>");
    expect(scrub("chrome://browser/content/ressac/sidebar.js:3:1", home)).toBe("chrome://browser/content/ressac/sidebar.js:3:1");
    expect(scrub("resource://app/x.mjs", home)).toBe("resource://app/x.mjs");
  });
});

describe("scrub hardening", () => {
  it("matches url schemes case-insensitively", () => {
    expect(scrub("HTTPS://x.fr/a and File:///Users/marie/a", home)).toBe("<url> and <url>");
  });
  it("replaces home only at a path boundary, trailing slash ignored", () => {
    for (const h of [home, home + "/"]) {
      expect(scrub("/Users/marie/x", h)).toBe("~/x");
      expect(scrub("in /Users/marie", h)).toBe("in ~");
      expect(scrub("/Users/marieX/f", h)).toBe("/Users/marieX/f");
    }
  });
  it("scrubs no home when it is empty or the root", () => {
    expect(scrub("/a/b", "")).toBe("/a/b");
    expect(scrub("/a/b", "/")).toBe("/a/b");
  });
});

describe("parseStack", () => {
  it("parses V8, oldest first", () => {
    const f = parseStack("Error: x\n    at inner (/a/b.js:1:2)\n    at /a/c.js:3:4");
    expect(f).toEqual([
      { function: "?", filename: "/a/c.js", lineno: 3, colno: 4 },
      { function: "inner", filename: "/a/b.js", lineno: 1, colno: 2 },
    ]);
  });
  it("parses SpiderMonkey, oldest first", () => {
    const f = parseStack("inner@chrome://x/a.js:1:2\nouter@chrome://x/b.js:5:6\n");
    expect(f.map((x) => x.function)).toEqual(["outer", "inner"]);
    expect(f[1]).toEqual({ function: "inner", filename: "chrome://x/a.js", lineno: 1, colno: 2 });
  });
});

describe("errorEnvelope", () => {
  const env = errorEnvelope(
    { source: "host", type: "Error", message: "ENOENT /Users/marie/x https://a.b/c", stack: "at f (/Users/marie/p.js:1:2)" },
    { release: "0.1.0", home, eventId: "e1", now: new Date("2026-11-10T10:00:00Z") },
  );
  const lines = env.split("\n");
  const ev = JSON.parse(lines[2]!);
  it("has three JSON lines and the expected fields", () => {
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0]!).event_id).toBe("e1");
    expect(JSON.parse(lines[1]!).type).toBe("event");
    expect(ev).toMatchObject({ event_id: "e1", release: "0.1.0", environment: "beta", platform: "node", tags: { source: "host" } });
    expect(ev.sdk.settings).toEqual({ infer_ip: "never" });
    expect(ev.user).toEqual({ ip_address: "0.0.0.0" });
    expect(ev.exception.values[0]).toMatchObject({ type: "Error", value: "ENOENT ~/x <url>" });
    expect(ev.exception.values[0].stacktrace.frames[0].filename).toBe("~/p.js");
  });
  it("drops a site named without a scheme, keeps code file names", () => {
    const message = "Navigation bloquée : intranet.boite.fr est hors des domaines permis (sidebar.js, 0.1.6)";
    const v = JSON.parse(errorEnvelope({ source: "chrome", type: "Error", message }, { release: "1", home, eventId: "e", now: new Date() }).split("\n")[2]!).exception.values[0];
    expect(v.value).toBe("Navigation bloquée : <host> est hors des domaines permis (sidebar.js, 0.1.6)");
  });
  it("omits the stacktrace when there are no frames", () => {
    const v = JSON.parse(errorEnvelope({ source: "host", type: "Error", message: "m" }, { release: "1", home, eventId: "e", now: new Date() }).split("\n")[2]!).exception.values[0];
    expect(v).not.toHaveProperty("stacktrace");
  });
  it("is anonymous", () => {
    for (const k of ["server_name", "request"]) expect(ev).not.toHaveProperty(k);
    expect(ev.contexts?.device).toBeUndefined();
    expect(env).not.toContain(home);
  });
});

describe("errorEnvelope caps", () => {
  it("caps the value to 300 chars and the stack to the 50 most recent frames", () => {
    const stack = Array.from({ length: 80 }, (_, i) => `f${i}@chrome://x/a.js:${i + 1}:1`).join("\n");
    const ev = JSON.parse(errorEnvelope({ source: "chrome", type: "Error", message: "x".repeat(5000), stack }, { release: "1", home, eventId: "e", now: new Date() }).split("\n")[2]!);
    const v = ev.exception.values[0];
    expect(v.value).toHaveLength(300);
    expect(v.stacktrace.frames).toHaveLength(50);
    // Oldest first: the last frame is the most recent one (f0).
    expect(v.stacktrace.frames.at(-1).function).toBe("f0");
    expect(v.stacktrace.frames[0].function).toBe("f49");
  });
});

describe("errorEnvelope hides quoted content", () => {
  const value = (message: string) =>
    JSON.parse(errorEnvelope({ source: "host", type: "Error", message }, { release: "1", home, eventId: "e", now: new Date() }).split("\n")[2]!).exception.values[0].value as string;
  it("replaces every quoted span", () => {
    expect(value(`Unexpected token 'h', "hello worl"... is not valid JSON`)).not.toContain("hello");
    const enoent = value("ENOENT: no such file or directory, open '/Users/marie/x'");
    expect(enoent).not.toContain("marie");
    expect(enoent).not.toContain("x'");
    expect(value("a `b` «c» d")).toBe('a "…" "…" d');
  });
  it("caps the value at 300 chars and leaves an unquoted message alone", () => {
    expect(value("y".repeat(500))).toHaveLength(300);
    expect(value("boom at line 3")).toBe("boom at line 3");
  });
});

describe("createReporter", () => {
  const make = (over: Record<string, unknown> = {}) => {
    const posts: string[] = [];
    const r = createReporter({
      dsn: "https://k@h.io/1", release: "0.1.0", home, enabled: () => true,
      post: async (u) => void posts.push(u), ...over,
    });
    return { posts, r };
  };
  const err = (i: number) => ({ source: "chrome" as const, type: "Error", message: `boom ${i}` });
  it("caps at 30", () => {
    const { posts, r } = make();
    for (let i = 0; i < 40; i++) r.report(err(i));
    expect(posts).toHaveLength(30);
  });
  it("dedupes", () => {
    const { posts, r } = make();
    for (let i = 0; i < 5; i++) r.report(err(1));
    expect(posts).toHaveLength(1);
  });
  it("sends nothing when disabled or without dsn", () => {
    const a = make({ enabled: () => false });
    a.r.report(err(1));
    const b = make({ dsn: "" });
    b.r.report(err(1));
    expect(a.posts.length + b.posts.length).toBe(0);
  });
  it("survives a rejecting post without waiting", async () => {
    let calls = 0;
    const { r } = make({ post: () => { calls++; return Promise.reject(new Error("net")); } });
    expect(() => { r.report(err(1)); r.report(err(1)); }).not.toThrow();
    await new Promise((x) => setTimeout(x, 0));
    expect(calls).toBe(1);
  });
  it("survives a synchronously throwing post", () => {
    const { r } = make({ post: () => { throw new Error("x"); } });
    expect(() => r.report(err(1))).not.toThrow();
  });
});

describe("session counting", () => {
  it("builds an anonymous session envelope", () => {
    const now = new Date("2026-11-11T10:00:00.000Z");
    const [h, i, p] = sessionEnvelope({ release: "0.1.0", installId: "inst", sessionId: "sess", now }).split("\n").map((l) => JSON.parse(l));
    expect(h).toEqual({ sent_at: now.toISOString() });
    expect(i).toEqual({ type: "session" });
    expect(p).toEqual({
      sid: "sess", did: "inst", init: true, started: now.toISOString(), timestamp: now.toISOString(),
      status: "exited", duration: 0, errors: 0, attrs: { release: "0.1.0", environment: "beta", ip_address: "0.0.0.0" },
    });
    expect(JSON.stringify([h, i, p])).not.toContain(home);
  });
  const make = () => {
    let stored: string | undefined;
    let n = 0;
    const posts: string[] = [];
    let on = true;
    const launch = (dsn = "https://k@h.io/1") =>
      launchSession({
        dsn, release: "0.1.0", enabled: () => on, post: async (_u, b) => void posts.push(b),
        ids: { get: () => stored, set: (v) => (stored = v), clear: () => (stored = undefined) },
        newId: () => `id${++n}`,
      });
    return { posts, launch, off: (v: boolean) => (on = v) };
  };
  const did = (b: string) => JSON.parse(b.split("\n")[2]!).did;
  it("keeps the same did across launches, a new one after off then on", () => {
    const { posts, launch, off } = make();
    launch();
    launch();
    off(false);
    launch();
    off(true);
    launch();
    expect(posts.map(did)).toEqual(["id1", "id1", "id4"]);
  });
  it("posts nothing when off or without dsn", () => {
    const { posts, launch, off } = make();
    off(false);
    launch();
    off(true);
    launch("");
    expect(posts).toHaveLength(0);
  });
});
