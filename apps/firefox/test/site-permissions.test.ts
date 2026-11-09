import { beforeEach, expect, test, vi } from "vitest";
import type { Issue } from "../shared/model";
import { createSitePermissions, type SitePermission } from "../chrome/store/site-permissions";

const DIR = "/data";
const FILE = `${DIR}/permissions.json`;
const meet = "https://meet.google.com";

let disk: Map<string, string>;
let questions: { ongletId: string | null; origine: string; permissions: SitePermission[]; lien?: string }[];
let answer: Issue;
let calls: unknown[][];
let profiles: string[];

const files = {
  read: async (p: string) => disk.get(p) ?? null,
  write: async (p: string, t: string) => void disk.set(p, t),
  remove: async (p: string) => void disk.delete(p),
};
const make = (o: Partial<Parameters<typeof createSitePermissions>[0]> = {}) =>
  createSitePermissions({
    dataDir: DIR,
    profiles: () => profiles,
    ask: async (d) => (questions.push(d), answer),
    firefox: { set: (...a) => calls.push(["set", ...a]), remove: (...a) => calls.push(["remove", ...a]) },
    files,
    ...o,
  });
const req = (kind: string, extra: Record<string, unknown> = {}) => ({ ongletId: "o1", fenetreId: "f1", profil: "defaut", origine: meet, kind, ...extra });
const saved = (path = FILE) => JSON.parse(disk.get(path) ?? "null");

beforeEach(() => {
  disk = new Map();
  questions = [];
  answer = "autoriser";
  calls = [];
  profiles = ["defaut"];
});

test("first request → we ask; the decision is remembered and the second goes through without asking", async () => {
  const p = make();
  expect(await p.handle(req("notifications"))).toBe(true);
  expect(questions).toEqual([{ ongletId: "o1", fenetreId: "f1", origine: meet, permissions: ["notifications"] }]);
  answer = "refuser";
  expect(await p.handle(req("notifications"))).toBe(true);
  expect(questions).toHaveLength(1);
  expect(saved()).toEqual({ [`${meet} notifications`]: "autoriser" });
});

test("camera + microphone: both permissions are needed", async () => {
  const p = make();
  expect(await p.handle(req("media", { mediaTypes: ["video", "audio"] }))).toBe(true);
  expect(questions.at(-1)?.permissions).toEqual(["media-camera", "media-micro"]);
  const other = "https://visio.fr";
  answer = "refuser";
  await p.handle(req("media", { origine: other, mediaTypes: ["audio"] }));
  answer = "autoriser";
  expect(await p.handle(req("media", { origine: other, mediaTypes: ["video", "audio"] }))).toBe(false);
  expect(questions.at(-1)?.permissions).toEqual(["media-camera"]);
});

test("fullscreen granted without asking; unknown permission denied without asking", async () => {
  const p = make();
  expect(await p.handle(req("fullscreen"))).toBe(true);
  expect(await p.handle(req("clipboard-sanitized-write"))).toBe(true);
  expect(await p.handle(req("midiSysex"))).toBe(false);
  expect(questions).toEqual([]);
});

test("verifier answers from the remembered decisions, never asking", async () => {
  const p = make();
  await p.ready;
  expect(p.check("defaut", meet, "notifications")).toBe(false);
  await p.handle(req("notifications"));
  expect(p.check("defaut", meet, "notifications")).toBe(true);
  expect(p.check("defaut", meet, "media", "video")).toBe(false);
  expect(p.check("defaut", meet, "fullscreen")).toBe(true);
  expect(questions).toHaveLength(1);
});

test("two simultaneous requests for the same permission ask only one question", async () => {
  const p = make();
  const r = await Promise.all([p.handle(req("geolocation")), p.handle(req("geolocation", { ongletId: "o2" }))]);
  expect(r).toEqual([true, true]);
  expect(questions).toHaveLength(1);
});

test("question withdrawn without an answer (tab closed): denied this time, nothing remembered, asked again afterwards", async () => {
  const p = make();
  answer = "retiree";
  expect(await p.handle(req("media", { mediaTypes: ["video"] }))).toBe(false);
  expect(disk.size).toBe(0);
  expect(calls).toEqual([["remove", null, null]]);
  answer = "autoriser";
  expect(await p.handle(req("media", { mediaTypes: ["video"] }))).toBe(true);
  expect(questions).toHaveLength(2);
});

test("camera then camera + microphone before any answer: the camera is only asked once", async () => {
  const replies: ((d: Issue) => void)[] = [];
  const p = make({ ask: (d) => (questions.push(d), new Promise((ok) => replies.push(ok))) });
  const video = p.handle(req("media", { mediaTypes: ["video"] }));
  const both = p.handle(req("media", { mediaTypes: ["video", "audio"] }));
  await p.ready;
  await vi.waitFor(() => expect(questions.map((d) => d.permissions)).toEqual([["media-camera"], ["media-micro"]]));
  replies[0]!("autoriser");
  replies[1]!("refuser");
  expect([await video, await both]).toEqual([true, false]);
  await vi.waitFor(() => expect(saved()).toEqual({ [`${meet} media-camera`]: "autoriser", [`${meet} media-micro`]: "refuser" }));
});

test("decisions survive a file reload", async () => {
  await make().handle(req("geolocation"));
  const p = make();
  await p.ready;
  expect(p.check("defaut", meet, "geolocation")).toBe(true);
  await p.forget("defaut", meet);
  const q = make();
  await q.ready;
  expect(q.check("defaut", meet, "geolocation")).toBe(false);
});

test("corrupted permissions.json → no decision, no crash", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  disk.set(FILE, "{pas du json");
  let p = make();
  await p.ready;
  expect(p.check("defaut", "https://a.fr", "notifications")).toBe(false);
  disk.set(FILE, JSON.stringify({ "https://a.fr notifications": "peut-être" }));
  p = make();
  await p.ready;
  expect(p.check("defaut", "https://a.fr", "notifications")).toBe(false);
  warn.mockRestore();
});

test("opening an external application (mailto:…): asked every time with the link, never remembered", async () => {
  const p = make();
  expect(await p.handle(req("openExternal", { lien: "mailto:a@b.fr" }))).toBe(true);
  expect(questions.at(-1)).toEqual({ ongletId: "o1", fenetreId: "f1", origine: meet, permissions: ["ouvrir-application"], lien: "mailto:a@b.fr" });
  answer = "refuser";
  expect(await p.handle(req("openExternal", { lien: "zoommtg://x" }))).toBe(false);
  expect(questions).toHaveLength(2);
  expect(disk.size).toBe(0);
  expect(p.check("defaut", meet, "openExternal")).toBe(false);
  expect(await p.handle(req("openExternal"))).toBe(false);
});

test("drm and midi are kept per (origin, profile); partage-ecran is asked again every time", async () => {
  const p = make();
  expect(await p.handle(req("drm"))).toBe(true);
  expect(await p.handle(req("drm"))).toBe(true);
  expect(await p.handle(req("midi"))).toBe(true);
  expect(await p.handle(req("midi"))).toBe(true);
  expect(questions.map((d) => d.permissions)).toEqual([["drm"], ["midi"]]);
  expect(p.check("defaut", meet, "drm")).toBe(true);
  questions = [];
  expect(await p.handle(req("partage-ecran"))).toBe(true);
  expect(await p.handle(req("partage-ecran"))).toBe(true);
  expect(questions.map((d) => d.permissions)).toEqual([["partage-ecran"], ["partage-ecran"]]);
  expect(p.check("defaut", meet, "partage-ecran")).toBe(false);
  expect(saved()).toEqual({ [`${meet} drm`]: "autoriser", [`${meet} midi`]: "autoriser" });
});

test("the same origin in another profile is asked again", async () => {
  const p = make();
  await p.handle(req("notifications"));
  await p.handle(req("notifications", { profil: "pro" }));
  expect(questions).toHaveLength(2);
  expect(p.check("pro", meet, "notifications")).toBe(true);
  expect(saved(`${DIR}/permissions-pro.json`)).toEqual({ [`${meet} notifications`]: "autoriser" });
});

test("each decision is copied into Firefox; forget and removeProfile remove it", async () => {
  const p = make();
  await p.handle(req("media", { mediaTypes: ["video", "audio"] }));
  await p.handle(req("notifications", { profil: "pro" }));
  expect(calls.slice(1)).toEqual([
    ["set", "defaut", meet, "media-camera", "autoriser"],
    ["set", "defaut", meet, "media-micro", "autoriser"],
    ["set", "pro", meet, "notifications", "autoriser"],
  ]);
  calls = [];
  await p.forget("defaut", meet);
  await p.removeProfile("pro");
  expect(calls).toEqual([["remove", "defaut", meet], ["remove", "pro", null]]);
  expect(saved()).toEqual({});
  expect(disk.has(`${DIR}/permissions-pro.json`)).toBe(false);
  expect(p.check("pro", meet, "notifications")).toBe(false);
});

test("at startup, Firefox is emptied then rebuilt from the profiles' files", async () => {
  disk.set(FILE, JSON.stringify({ [`${meet} geolocation`]: "autoriser" }));
  disk.set(`${DIR}/permissions-pro.json`, JSON.stringify({ "https://a.fr drm": "refuser" }));
  profiles = ["defaut", "pro"];
  await make().ready;
  expect(calls).toEqual([
    ["remove", null, null],
    ["set", "defaut", meet, "geolocation", "autoriser"],
    ["set", "pro", "https://a.fr", "drm", "refuser"],
  ]);
});

test("an unreadable file: no decision, nothing is rewritten before a new decision", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  disk.set(FILE, "{pas du json");
  const write = vi.fn(files.write);
  const p = make({ files: { ...files, write } });
  await p.ready;
  expect(write).not.toHaveBeenCalled();
  expect(disk.get(FILE)).toBe("{pas du json");
  await p.handle(req("notifications"));
  expect(write).toHaveBeenCalled();
  warn.mockRestore();
});

test("a request arriving before loading ends waits for ready", async () => {
  disk.set(FILE, JSON.stringify({ [`${meet} notifications`]: "autoriser" }));
  let release!: () => void;
  const gate = new Promise<void>((ok) => (release = ok));
  const p = make({ files: { ...files, read: async (path) => (await gate, files.read(path)) } });
  const r = p.handle(req("notifications"));
  await Promise.resolve();
  release();
  expect(await r).toBe(true);
  expect(questions).toEqual([]);
});

test("the written file has the expected format", async () => {
  await make().handle(req("geolocation", { origine: "https://a.test" }));
  expect(JSON.parse(disk.get(FILE)!)).toEqual({ "https://a.test geolocation": "autoriser" });
});

test("an unreadable origin in the file stops neither the startup nor the other decisions", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  disk.set(FILE, JSON.stringify({ "pas une origine notifications": "autoriser", [`${meet} geolocation`]: "autoriser" }));
  const p = make({
    firefox: { set: (_p, origin, ...r) => (origin.startsWith("pas") ? (() => { throw new Error("bad uri"); })() : calls.push(["set", origin, ...r])), remove: () => {} },
  });
  await p.ready;
  expect(calls).toEqual([["set", meet, "geolocation", "autoriser"]]);
  expect(await p.handle(req("geolocation"))).toBe(true);
  await p.forget("defaut", meet);
  warn.mockRestore();
});

test("removeProfile removes from Firefox right away, before the caller removes the container", async () => {
  const p = make();
  const done = p.removeProfile("pro");
  expect(calls.at(-1)).toEqual(["remove", "pro", null]);
  await done;
});

test("profile removed during a question: the late answer counts for the request, without a write or a copy", async () => {
  const replies: ((d: Issue) => void)[] = [];
  const p = make({ ask: (d) => (questions.push(d), new Promise((ok) => replies.push(ok))) });
  await p.ready;
  const r = p.handle(req("notifications", { profil: "pro" }));
  await vi.waitFor(() => expect(replies).toHaveLength(1));
  await p.removeProfile("pro");
  calls = [];
  replies[0]!("autoriser");
  expect(await r).toBe(true);
  await Promise.resolve();
  expect(calls).toEqual([]);
  expect(disk.has(`${DIR}/permissions-pro.json`)).toBe(false);
  expect(p.check("pro", meet, "notifications")).toBe(false);
});
