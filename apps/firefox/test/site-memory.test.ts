import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, test } from "vitest";
import { KEY_INVALID, SiteMemory, VALEUR_NON_JSON } from "../../../packages/noyau/src/index";
import { creerPositions, memoireOp, REFUS_MEMOIRE } from "../noyau/site-memory";

// The site memory, on the host's memoireOp: the sender checks
// (sub-frame, sign-in window, page off the site, no grant) are the chrome's, in site-frames.test.ts.

let memoire: SiteMemory;
let refusee: boolean;
const op = (d: object) => memoireOp(async () => {
  if (refusee) throw new Error("appli de site en cours de suppression : vidola");
  return memoire;
}, { id: "vidola", adresse: "/series/x", ...d });

beforeEach(async () => {
  refusee = false;
  memoire = await SiteMemory.ouvrir(mkdtempSync(join(tmpdir(), "site-memory-")), "vidola");
});

test("retenir takes the address the chrome gives; lire, oublier", async () => {
  expect(await op({ op: "retenir", cle: "encours.the-bear", valeur: { titre: "The Bear" }, adresse: "/serie/the-bear?e=4" })).toEqual({ ok: true });
  expect(memoire.contenu().valeurs["encours.the-bear"]).toMatchObject({ valeur: { titre: "The Bear" }, adresse: "/serie/the-bear?e=4" });
  expect(await op({ op: "lire", cle: "encours.the-bear" })).toEqual({ ok: true, valeur: { titre: "The Bear" } });
  expect(await op({ op: "lire", cle: "absente" })).toEqual({ ok: true, valeur: null });
  expect(await op({ op: "oublier", cle: "encours.the-bear" })).toEqual({ ok: true });
  expect(memoire.contenu().valeurs).toEqual({});
});

test("the memory's named refusals (key, non-JSON value)", async () => {
  expect(await op({ op: "retenir", cle: "", valeur: 1 })).toEqual({ ok: false, erreur: KEY_INVALID });
  expect(await op({ op: "retenir", cle: "x", valeur: undefined })).toEqual({ ok: false, erreur: VALEUR_NON_JSON });
});

test("a malformed request is refused, nothing written", async () => {
  for (const d of [{ op: "effacer", cle: "x" }, { op: "lire", cle: 3 }, { op: "retenir", cle: "x", valeur: 1, adresse: 4 }, { op: "retenir", cle: "x", valeur: 1, id: null }])
    expect(await op(d)).toEqual({ ok: false, erreur: REFUS_MEMOIRE });
  for (const d of [null, "x", 3]) expect(await memoireOp(async () => memoire, d)).toEqual({ ok: false, erreur: REFUS_MEMOIRE });
  expect(memoire.contenu().valeurs).toEqual({});
});

test("memory refused by the service (app being deleted): the memory's refusal, nothing written", async () => {
  refusee = true;
  for (const o of ["retenir", "lire", "oublier"]) expect(await op({ op: o, cle: "x", valeur: 1 })).toEqual({ ok: false, erreur: REFUS_MEMOIRE });
  expect(memoire.contenu().valeurs).toEqual({});
});

// --- Video resume: the positions, on the host's creerPositions. The
// sender checks (view, grant, repriseDansCadre, page address) are the chrome's, in site-frames.test.ts.

let accorde: boolean;
let horloge: number;
let differes: { f: () => void; ms: number }[];
let positions: ReturnType<typeof creerPositions>;
let dossier: string;
const flush = () => new Promise((r) => setTimeout(r));
const cadre = "1:10";
const note = (p: object, c = cadre) => positions.position({ id: "vidola", cadre: c, adresse: "/episode/4", ...p });
const reprise = (d: unknown, adresse = "/episode/4") => positions.reprise({ id: "vidola", adresse, duree: d });
/** A note a bit later (past the one-per-second limit of a frame). */
const plusTard = (p: object, c = cadre) => ((horloge += 1000), note(p, c));

beforeEach(async () => {
  accorde = true;
  horloge = 0;
  differes = [];
  dossier = mkdtempSync(join(tmpdir(), "site-positions-"));
  memoire = await SiteMemory.ouvrir(dossier, "vidola");
  positions = creerPositions({ memoire: async () => memoire, accorde: () => accorde, maintenant: () => horloge, differer: (f, ms) => void differes.push({ f, ms }) });
});

test("position: noted under the page's address, from the player's frame as from the page's", async () => {
  await note({ t: 70, duree: 90, adresse: "/episode/4?s=1" }, "1:20");
  expect(memoire.contenu().positions).toEqual({ "/episode/4?s=1": { t: 70, duree: 90, quand: expect.any(String) } });
  await plusTard({ t: 72, duree: 90, adresse: "/episode/4?s=1" }, "1:10");
  expect(memoire.position("/episode/4?s=1")?.t).toBe(72);
  expect(Object.keys(memoire.contenu().positions)).toEqual(["/episode/4?s=1"]);
});

test("position: refused without grant, and for invalid values", async () => {
  accorde = false;
  await plusTard({ t: 70, duree: 90 });
  accorde = true;
  for (const p of [{ t: "70", duree: 90 }, { t: 70 }, { t: Infinity, duree: 90 }, { t: 70, duree: 90, adresse: 4 }, { t: 70, duree: 90, id: null }, { t: 70, duree: 90, cadre: 4 }, { t: 70, duree: 90, cadre: "x".repeat(65) }])
    await positions.position({ id: "vidola", cadre, adresse: "/episode/4", ...p });
  for (const p of [null, "x", 3]) await positions.position(p);
  expect(memoire.contenu().positions).toEqual({});
});

test("position: at most one note a second per frame; the last too early is written at the second's end; the end, at once", async () => {
  await note({ t: 70, duree: 90 });
  horloge += 300;
  await note({ t: 71, duree: 90 });
  horloge += 300;
  await note({ t: 71.5, duree: 90 });
  expect(memoire.position("/episode/4")?.t).toBe(70);
  // One delayed write, at the second's end, with the last value (a pause just after a jump is not lost).
  expect(differes.map((d) => d.ms)).toEqual([700]);
  horloge = 1000;
  differes.shift()!.f();
  await flush();
  expect(memoire.position("/episode/4")?.t).toBe(71.5);
  // Another frame of the page is not slowed by the first.
  await note({ t: 72, duree: 90 }, "1:20");
  expect(memoire.position("/episode/4")?.t).toBe(72);
  // The end goes at once and cancels a waiting note (which would bring a forgotten position back).
  horloge += 100;
  await note({ t: 80, duree: 90 });
  expect(differes).toHaveLength(1);
  await note({ t: 90, duree: 90, fin: true });
  expect(memoire.position("/episode/4")).toBeNull();
  differes.shift()!.f();
  await flush();
  expect(memoire.position("/episode/4")).toBeNull();
  horloge += 1000;
  await note({ t: 30, duree: 90 });
  expect(memoire.position("/episode/4")?.t).toBe(30);
});

test("reprise: the page's position for a video of the same duration (±2 s), at each new element; nothing under the player's address", async () => {
  memoire.noterPosition("/episode/4", 70, 90);
  memoire.noterPosition("https://www.lecteur.example/embed/9", 30, 90);
  expect(await reprise(90)).toBe(70);
  expect(await reprise(90)).toBe(70);
  expect(await reprise(91.5)).toBe(70);
  expect(await reprise(92.5)).toBeNull();
  for (const d of [undefined, null, {}, "90", NaN, 0, -1]) expect(await reprise(d)).toBeNull();
  accorde = false;
  expect(await reprise(90)).toBeNull();
});

test("an advert of another duration neither takes the position nor replaces or erases it; the player that came second resumes", async () => {
  memoire.noterPosition("/episode/4", 70, 90);
  expect(await reprise(75)).toBeNull();
  await plusTard({ t: 0.2, duree: 75 }, "1:30");
  await plusTard({ t: 40, duree: 75 }, "1:30");
  await plusTard({ t: 75, duree: 75, fin: true }, "1:30");
  expect(memoire.position("/episode/4")).toMatchObject({ t: 70, duree: 90 });
  expect(await reprise(90)).toBe(70);
});

test("« Lecteur 2 »: the frame changes player, the same video resumes where the first was", async () => {
  memoire.noterPosition("/episode/4", 1200, 2700);
  expect(await reprise(2700)).toBe(1200);
  await plusTard({ t: 1210, duree: 2700 });
  expect(await reprise(2699)).toBe(1210);
  expect(memoire.position("/episode/4")?.t).toBe(1210);
});

test("without a kept position the first video long enough notes; a video of another duration does not replace it", async () => {
  expect(await reprise(90, "/episode/5")).toBeNull();
  await plusTard({ t: 40, duree: 90, adresse: "/episode/5" });
  expect(memoire.position("/episode/5")).toMatchObject({ t: 40, duree: 90 });
  await plusTard({ t: 10, duree: 300, adresse: "/episode/5" }, "1:20");
  expect(memoire.position("/episode/5")).toMatchObject({ t: 40, duree: 90 });
});

test("each address keeps and resumes its own position (pushState to another episode)", async () => {
  memoire.noterPosition("/episode/4", 70, 90);
  memoire.noterPosition("/episode/5", 720, 1500);
  expect(await reprise(90)).toBe(70);
  expect(await reprise(1500, "/episode/5")).toBe(720);
  await plusTard({ t: 730, duree: 1500, adresse: "/episode/5" });
  expect(memoire.position("/episode/5")?.t).toBe(730);
  expect(memoire.position("/episode/4")).toMatchObject({ t: 70, duree: 90 });
});

test("a note received before forget is dropped, delayed write included", async () => {
  await note({ t: 70, duree: 90 });
  horloge += 300;
  // Too early: waits for its second.
  await note({ t: 75, duree: 90 });
  expect(differes).toHaveLength(1);
  // « Oublier »: notes cancelled, then the memory erased.
  positions.annulerNotes("vidola");
  await memoire.effacer();
  horloge = 1000;
  differes.shift()!.f();
  await new Promise((r) => setTimeout(r, 1500));
  expect(memoire.contenu().positions).toEqual({});
  expect(existsSync(join(dossier, "vidola", "memoire.json"))).toBe(false);
  // A fresh note after the forgetting is kept again.
  horloge += 2000;
  await note({ t: 30, duree: 90 });
  expect(memoire.position("/episode/4")?.t).toBe(30);
});

test("grant withdrawn before the delayed write: the note is not written", async () => {
  await note({ t: 70, duree: 90 });
  horloge += 300;
  await note({ t: 75, duree: 90 });
  accorde = false;
  horloge = 1000;
  differes.shift()!.f();
  await flush();
  expect(memoire.position("/episode/4")?.t).toBe(70);
});
