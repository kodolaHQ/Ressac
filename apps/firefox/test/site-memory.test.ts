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
}, { id: "vidola", adresse: "/series/x", ...d });

beforeEach(async () => {
  denied = false;
  memory = await SiteMemory.ouvrir(mkdtempSync(join(tmpdir(), "site-memory-")), "vidola");
});

test("retenir takes the address the chrome gives; lire, oublier", async () => {
  expect(await op({ op: "retenir", cle: "encours.the-bear", valeur: { titre: "The Bear" }, adresse: "/serie/the-bear?e=4" })).toEqual({ ok: true });
  expect(memory.contenu().valeurs["encours.the-bear"]).toMatchObject({ valeur: { titre: "The Bear" }, adresse: "/serie/the-bear?e=4" });
  expect(await op({ op: "lire", cle: "encours.the-bear" })).toEqual({ ok: true, valeur: { titre: "The Bear" } });
  expect(await op({ op: "lire", cle: "absente" })).toEqual({ ok: true, valeur: null });
  expect(await op({ op: "oublier", cle: "encours.the-bear" })).toEqual({ ok: true });
  expect(memory.contenu().valeurs).toEqual({});
});

test("the memory's named refusals (key, non-JSON value)", async () => {
  expect(await op({ op: "retenir", cle: "", valeur: 1 })).toEqual({ ok: false, erreur: KEY_INVALID });
  expect(await op({ op: "retenir", cle: "x", valeur: undefined })).toEqual({ ok: false, erreur: NON_JSON_VALUE });
});

test("a malformed request is refused, nothing written", async () => {
  for (const d of [{ op: "effacer", cle: "x" }, { op: "lire", cle: 3 }, { op: "retenir", cle: "x", valeur: 1, adresse: 4 }, { op: "retenir", cle: "x", valeur: 1, id: null }])
    expect(await op(d)).toEqual({ ok: false, erreur: MEMORY_DENIAL });
  for (const d of [null, "x", 3]) expect(await memoryOp(async () => memory, d)).toEqual({ ok: false, erreur: MEMORY_DENIAL });
  expect(memory.contenu().valeurs).toEqual({});
});

test("memory refused by the service (app being deleted): the memory's refusal, nothing written", async () => {
  denied = true;
  for (const o of ["retenir", "lire", "oublier"]) expect(await op({ op: o, cle: "x", valeur: 1 })).toEqual({ ok: false, erreur: MEMORY_DENIAL });
  expect(memory.contenu().valeurs).toEqual({});
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
const note = (p: object, c = frame) => positions.position({ id: "vidola", cadre: c, adresse: "/episode/4", ...p });
const resume = (d: unknown, url = "/episode/4") => positions.reprise({ id: "vidola", adresse: url, duree: d });
/** A note a bit later (past the one-per-second limit of a frame). */
const later = (p: object, c = frame) => ((clock += 1000), note(p, c));

beforeEach(async () => {
  granted = true;
  clock = 0;
  deferred = [];
  folder = mkdtempSync(join(tmpdir(), "site-positions-"));
  memory = await SiteMemory.ouvrir(folder, "vidola");
  positions = createPositions({ memoire: async () => memory, accorde: () => granted, maintenant: () => clock, differer: (f, ms) => void deferred.push({ f, ms }) });
});

test("position: noted under the page's address, from the player's frame as from the page's", async () => {
  await note({ t: 70, duree: 90, adresse: "/episode/4?s=1" }, "1:20");
  expect(memory.contenu().positions).toEqual({ "/episode/4?s=1": { t: 70, duree: 90, quand: expect.any(String) } });
  await later({ t: 72, duree: 90, adresse: "/episode/4?s=1" }, "1:10");
  expect(memory.position("/episode/4?s=1")?.t).toBe(72);
  expect(Object.keys(memory.contenu().positions)).toEqual(["/episode/4?s=1"]);
});

test("position: refused without grant, and for invalid values", async () => {
  granted = false;
  await later({ t: 70, duree: 90 });
  granted = true;
  for (const p of [{ t: "70", duree: 90 }, { t: 70 }, { t: Infinity, duree: 90 }, { t: 70, duree: 90, adresse: 4 }, { t: 70, duree: 90, id: null }, { t: 70, duree: 90, cadre: 4 }, { t: 70, duree: 90, cadre: "x".repeat(65) }])
    await positions.position({ id: "vidola", cadre: frame, adresse: "/episode/4", ...p });
  for (const p of [null, "x", 3]) await positions.position(p);
  expect(memory.contenu().positions).toEqual({});
});

test("position: at most one note a second per frame; the last too early is written at the second's end; the end, at once", async () => {
  await note({ t: 70, duree: 90 });
  clock += 300;
  await note({ t: 71, duree: 90 });
  clock += 300;
  await note({ t: 71.5, duree: 90 });
  expect(memory.position("/episode/4")?.t).toBe(70);
  // One delayed write, at the second's end, with the last value (a pause just after a jump is not lost).
  expect(deferred.map((d) => d.ms)).toEqual([700]);
  clock = 1000;
  deferred.shift()!.f();
  await flush();
  expect(memory.position("/episode/4")?.t).toBe(71.5);
  // Another frame of the page is not slowed by the first.
  await note({ t: 72, duree: 90 }, "1:20");
  expect(memory.position("/episode/4")?.t).toBe(72);
  // The end goes at once and cancels a waiting note (which would bring a forgotten position back).
  clock += 100;
  await note({ t: 80, duree: 90 });
  expect(deferred).toHaveLength(1);
  await note({ t: 90, duree: 90, fin: true });
  expect(memory.position("/episode/4")).toBeNull();
  deferred.shift()!.f();
  await flush();
  expect(memory.position("/episode/4")).toBeNull();
  clock += 1000;
  await note({ t: 30, duree: 90 });
  expect(memory.position("/episode/4")?.t).toBe(30);
});

test("reprise: the page's position for a video of the same duration (±2 s), at each new element; nothing under the player's address", async () => {
  memory.noterPosition("/episode/4", 70, 90);
  memory.noterPosition("https://www.lecteur.example/embed/9", 30, 90);
  expect(await resume(90)).toBe(70);
  expect(await resume(90)).toBe(70);
  expect(await resume(91.5)).toBe(70);
  expect(await resume(92.5)).toBeNull();
  for (const d of [undefined, null, {}, "90", NaN, 0, -1]) expect(await resume(d)).toBeNull();
  granted = false;
  expect(await resume(90)).toBeNull();
});

test("an advert of another duration neither takes the position nor replaces or erases it; the player that came second resumes", async () => {
  memory.noterPosition("/episode/4", 70, 90);
  expect(await resume(75)).toBeNull();
  await later({ t: 0.2, duree: 75 }, "1:30");
  await later({ t: 40, duree: 75 }, "1:30");
  await later({ t: 75, duree: 75, fin: true }, "1:30");
  expect(memory.position("/episode/4")).toMatchObject({ t: 70, duree: 90 });
  expect(await resume(90)).toBe(70);
});

test("« Lecteur 2 »: the frame changes player, the same video resumes where the first was", async () => {
  memory.noterPosition("/episode/4", 1200, 2700);
  expect(await resume(2700)).toBe(1200);
  await later({ t: 1210, duree: 2700 });
  expect(await resume(2699)).toBe(1210);
  expect(memory.position("/episode/4")?.t).toBe(1210);
});

test("without a kept position the first video long enough notes; a video of another duration does not replace it", async () => {
  expect(await resume(90, "/episode/5")).toBeNull();
  await later({ t: 40, duree: 90, adresse: "/episode/5" });
  expect(memory.position("/episode/5")).toMatchObject({ t: 40, duree: 90 });
  await later({ t: 10, duree: 300, adresse: "/episode/5" }, "1:20");
  expect(memory.position("/episode/5")).toMatchObject({ t: 40, duree: 90 });
});

test("each address keeps and resumes its own position (pushState to another episode)", async () => {
  memory.noterPosition("/episode/4", 70, 90);
  memory.noterPosition("/episode/5", 720, 1500);
  expect(await resume(90)).toBe(70);
  expect(await resume(1500, "/episode/5")).toBe(720);
  await later({ t: 730, duree: 1500, adresse: "/episode/5" });
  expect(memory.position("/episode/5")?.t).toBe(730);
  expect(memory.position("/episode/4")).toMatchObject({ t: 70, duree: 90 });
});

test("a note received before forget is dropped, delayed write included", async () => {
  await note({ t: 70, duree: 90 });
  clock += 300;
  // Too early: waits for its second.
  await note({ t: 75, duree: 90 });
  expect(deferred).toHaveLength(1);
  // « Oublier »: notes cancelled, then the memory erased.
  positions.annulerNotes("vidola");
  await memory.effacer();
  clock = 1000;
  deferred.shift()!.f();
  await new Promise((r) => setTimeout(r, 1500));
  expect(memory.contenu().positions).toEqual({});
  expect(existsSync(join(folder, "vidola", "memoire.json"))).toBe(false);
  // A fresh note after the forgetting is kept again.
  clock += 2000;
  await note({ t: 30, duree: 90 });
  expect(memory.position("/episode/4")?.t).toBe(30);
});

test("grant withdrawn before the delayed write: the note is not written", async () => {
  await note({ t: 70, duree: 90 });
  clock += 300;
  await note({ t: 75, duree: 90 });
  granted = false;
  clock = 1000;
  deferred.shift()!.f();
  await flush();
  expect(memory.position("/episode/4")?.t).toBe(70);
});
