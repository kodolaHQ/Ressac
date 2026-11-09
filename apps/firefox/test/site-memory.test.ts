import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, test } from "vitest";
import { KEY_INVALID, SiteMemory, NON_JSON_VALUE } from "../../../packages/kernel/src/index";
import { createPositions, memoryOp, MEMORY_DENIAL } from "../host/site-memory";

// The site memory, on the host's memoireOp: the sender checks
// (sub-frame, sign-in window, page off the site, no grant) are the chrome's, in site-frames.test.ts.

let memory: SiteMemory;
let denied: boolean;
const op = (d: object) => memoryOp(async () => {
  if (denied) throw new Error("appli de site en cours de suppression : vidola");
  return memory;
}, { id: "vidola", url: "/series/x", ...d });

beforeEach(async () => {
  denied = false;
  memory = await SiteMemory.open(mkdtempSync(join(tmpdir(), "site-memory-")), "vidola");
});

test("retenir takes the address the chrome gives; lire, oublier", async () => {
  expect(await op({ op: "retenir", key: "encours.the-bear", value: { title: "The Bear" }, url: "/serie/the-bear?e=4" })).toEqual({ ok: true });
  expect(memory.content().values["encours.the-bear"]).toMatchObject({ value: { title: "The Bear" }, url: "/serie/the-bear?e=4" });
  expect(await op({ op: "lire", key: "encours.the-bear" })).toEqual({ ok: true, value: { title: "The Bear" } });
  expect(await op({ op: "lire", key: "absente" })).toEqual({ ok: true, value: null });
  expect(await op({ op: "oublier", key: "encours.the-bear" })).toEqual({ ok: true });
  expect(memory.content().values).toEqual({});
});

test("the memory's named refusals (key, non-JSON value)", async () => {
  expect(await op({ op: "retenir", key: "", value: 1 })).toEqual({ ok: false, error: KEY_INVALID });
  expect(await op({ op: "retenir", key: "x", value: undefined })).toEqual({ ok: false, error: NON_JSON_VALUE });
});

test("a malformed request is refused, nothing written", async () => {
  for (const d of [{ op: "effacer", key: "x" }, { op: "lire", key: 3 }, { op: "retenir", key: "x", value: 1, url: 4 }, { op: "retenir", key: "x", value: 1, id: null }])
    expect(await op(d)).toEqual({ ok: false, error: MEMORY_DENIAL });
  for (const d of [null, "x", 3]) expect(await memoryOp(async () => memory, d)).toEqual({ ok: false, error: MEMORY_DENIAL });
  expect(memory.content().values).toEqual({});
});

test("memory refused by the service (app being deleted): the memory's refusal, nothing written", async () => {
  denied = true;
  for (const o of ["retenir", "lire", "oublier"]) expect(await op({ op: o, key: "x", value: 1 })).toEqual({ ok: false, error: MEMORY_DENIAL });
  expect(memory.content().values).toEqual({});
});

// --- Video resume: the positions, on the host's createPositions. The
// sender checks (view, grant, repriseDansCadre, page address) are the chrome's, in site-frames.test.ts.

let granted: boolean;
let clock: number;
let deferred: { f: () => void; ms: number }[];
let positions: ReturnType<typeof createPositions>;
let folder: string;
const flush = () => new Promise((r) => setTimeout(r));
const frame = "1:10";
const note = (p: object, c = frame) => positions.position({ id: "vidola", frame: c, url: "/episode/4", ...p });
const resume = (d: unknown, url = "/episode/4") => positions.resume({ id: "vidola", url: url, duration: d });
/** A note a bit later (past the one-per-second limit of a frame). */
const later = (p: object, c = frame) => ((clock += 1000), note(p, c));

beforeEach(async () => {
  granted = true;
  clock = 0;
  deferred = [];
  folder = mkdtempSync(join(tmpdir(), "site-positions-"));
  memory = await SiteMemory.open(folder, "vidola");
  positions = createPositions({ memory: async () => memory, granted: () => granted, now: () => clock, defer: (f, ms) => void deferred.push({ f, ms }) });
});

test("position: noted under the page's address, from the player's frame as from the page's", async () => {
  await note({ t: 70, duration: 90, url: "/episode/4?s=1" }, "1:20");
  expect(memory.content().positions).toEqual({ "/episode/4?s=1": { t: 70, duration: 90, when: expect.any(String) } });
  await later({ t: 72, duration: 90, url: "/episode/4?s=1" }, "1:10");
  expect(memory.position("/episode/4?s=1")?.t).toBe(72);
  expect(Object.keys(memory.content().positions)).toEqual(["/episode/4?s=1"]);
});

test("position: refused without grant, and for invalid values", async () => {
  granted = false;
  await later({ t: 70, duration: 90 });
  granted = true;
  for (const p of [{ t: "70", duration: 90 }, { t: 70 }, { t: Infinity, duration: 90 }, { t: 70, duration: 90, url: 4 }, { t: 70, duration: 90, id: null }, { t: 70, duration: 90, frame: 4 }, { t: 70, duration: 90, frame: "x".repeat(65) }])
    await positions.position({ id: "vidola", frame: frame, url: "/episode/4", ...p });
  for (const p of [null, "x", 3]) await positions.position(p);
  expect(memory.content().positions).toEqual({});
});

test("position: at most one note a second per frame; the last too early is written at the second's end; the end, at once", async () => {
  await note({ t: 70, duration: 90 });
  clock += 300;
  await note({ t: 71, duration: 90 });
  clock += 300;
  await note({ t: 71.5, duration: 90 });
  expect(memory.position("/episode/4")?.t).toBe(70);
  // One delayed write, at the second's end, with the last value (a pause just after a jump is not lost).
  expect(deferred.map((d) => d.ms)).toEqual([700]);
  clock = 1000;
  deferred.shift()!.f();
  await flush();
  expect(memory.position("/episode/4")?.t).toBe(71.5);
  // Another frame of the page is not slowed by the first.
  await note({ t: 72, duration: 90 }, "1:20");
  expect(memory.position("/episode/4")?.t).toBe(72);
  // The end goes at once and cancels a waiting note (which would bring a forgotten position back).
  clock += 100;
  await note({ t: 80, duration: 90 });
  expect(deferred).toHaveLength(1);
  await note({ t: 90, duration: 90, end: true });
  expect(memory.position("/episode/4")).toBeNull();
  deferred.shift()!.f();
  await flush();
  expect(memory.position("/episode/4")).toBeNull();
  clock += 1000;
  await note({ t: 30, duration: 90 });
  expect(memory.position("/episode/4")?.t).toBe(30);
});

test("reprise: the page's position for a video of the same duration (±2 s), at each new element; nothing under the player's address", async () => {
  memory.notePosition("/episode/4", 70, 90);
  memory.notePosition("https://www.lecteur.example/embed/9", 30, 90);
  expect(await resume(90)).toBe(70);
  expect(await resume(90)).toBe(70);
  expect(await resume(91.5)).toBe(70);
  expect(await resume(92.5)).toBeNull();
  for (const d of [undefined, null, {}, "90", NaN, 0, -1]) expect(await resume(d)).toBeNull();
  granted = false;
  expect(await resume(90)).toBeNull();
});

test("an advert of another duration neither takes the position nor replaces or erases it; the player that came second resumes", async () => {
  memory.notePosition("/episode/4", 70, 90);
  expect(await resume(75)).toBeNull();
  await later({ t: 0.2, duration: 75 }, "1:30");
  await later({ t: 40, duration: 75 }, "1:30");
  await later({ t: 75, duration: 75, end: true }, "1:30");
  expect(memory.position("/episode/4")).toMatchObject({ t: 70, duration: 90 });
  expect(await resume(90)).toBe(70);
});

test("« Lecteur 2 »: the frame changes player, the same video resumes where the first was", async () => {
  memory.notePosition("/episode/4", 1200, 2700);
  expect(await resume(2700)).toBe(1200);
  await later({ t: 1210, duration: 2700 });
  expect(await resume(2699)).toBe(1210);
  expect(memory.position("/episode/4")?.t).toBe(1210);
});

test("without a kept position the first video long enough notes; a video of another duration does not replace it", async () => {
  expect(await resume(90, "/episode/5")).toBeNull();
  await later({ t: 40, duration: 90, url: "/episode/5" });
  expect(memory.position("/episode/5")).toMatchObject({ t: 40, duration: 90 });
  await later({ t: 10, duration: 300, url: "/episode/5" }, "1:20");
  expect(memory.position("/episode/5")).toMatchObject({ t: 40, duration: 90 });
});

test("each address keeps and resumes its own position (pushState to another episode)", async () => {
  memory.notePosition("/episode/4", 70, 90);
  memory.notePosition("/episode/5", 720, 1500);
  expect(await resume(90)).toBe(70);
  expect(await resume(1500, "/episode/5")).toBe(720);
  await later({ t: 730, duration: 1500, url: "/episode/5" });
  expect(memory.position("/episode/5")?.t).toBe(730);
  expect(memory.position("/episode/4")).toMatchObject({ t: 70, duration: 90 });
});

test("a note received before forget is dropped, delayed write included", async () => {
  await note({ t: 70, duration: 90 });
  clock += 300;
  // Too early: waits for its second.
  await note({ t: 75, duration: 90 });
  expect(deferred).toHaveLength(1);
  // « Oublier »: notes cancelled, then the memory erased.
  positions.cancelNotes("vidola");
  await memory.erase();
  clock = 1000;
  deferred.shift()!.f();
  await new Promise((r) => setTimeout(r, 1500));
  expect(memory.content().positions).toEqual({});
  expect(existsSync(join(folder, "vidola", "memory.json"))).toBe(false);
  // A fresh note after the forgetting is kept again.
  clock += 2000;
  await note({ t: 30, duration: 90 });
  expect(memory.position("/episode/4")?.t).toBe(30);
});

test("grant withdrawn before the delayed write: the note is not written", async () => {
  await note({ t: 70, duration: 90 });
  clock += 300;
  await note({ t: 75, duration: 90 });
  granted = false;
  clock = 1000;
  deferred.shift()!.f();
  await flush();
  expect(memory.position("/episode/4")?.t).toBe(70);
});
