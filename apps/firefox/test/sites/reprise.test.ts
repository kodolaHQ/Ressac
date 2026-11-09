import { expect, test } from "vitest";
import { DUREE_MIN_REPRISE_S, ECART_POSITION_MS, RECUL_REPRISE_S, SuiviReprise } from "../../core/reprise";

/** A tracker with a test clock and the position the main process returns. */
function suivi(connue: number | null = null) {
  const notes: [number, number][] = [];
  const fins: boolean[] = [];
  const durees: number[] = [];
  let demandes = 0;
  let maintenant = 0;
  let reponse: (p: number | null) => void = () => {};
  let differee = false;
  const s = new SuiviReprise({
    noter: (t, duree, fin) => {
      notes.push([t, duree]);
      fins.push(fin);
    },
    demander: (duree) => {
      demandes++;
      durees.push(duree);
      return differee ? new Promise((ok) => (reponse = ok)) : Promise.resolve(connue);
    },
    maintenant: () => maintenant,
  });
  return {
    s,
    notes,
    fins,
    durees,
    demandes: () => demandes,
    horloge: (ms: number) => void (maintenant = ms),
    differer: () => void (differee = true),
    repondre: (p: number | null) => reponse(p),
  };
}

test("the plan's values", () => {
  expect([DUREE_MIN_REPRISE_S, ECART_POSITION_MS, RECUL_REPRISE_S]).toEqual([60, 10_000, 5]);
});

test("timeupdate every second for 35 s: 4 noter (0, 10, 20, 30 s)", async () => {
  const { s, notes, horloge } = suivi();
  const cle = {};
  expect(await s.surEvenement("play", { currentTime: 0, duration: 1500, cle })).toBeNull();
  for (let t = 0; t <= 35; t++) {
    horloge(t * 1000);
    expect(await s.surEvenement("timeupdate", { currentTime: t, duration: 1500, cle })).toBeNull();
  }
  expect(notes).toEqual([
    [0, 1500],
    [10, 1500],
    [20, 1500],
    [30, 1500],
  ]);
});

test("pause: noter right away; ended too, marked as the end", async () => {
  const { s, notes, fins, horloge } = suivi();
  const cle = {};
  await s.surEvenement("play", { currentTime: 0, duration: 1500, cle });
  await s.surEvenement("timeupdate", { currentTime: 1, duration: 1500, cle });
  horloge(2000);
  await s.surEvenement("pause", { currentTime: 2, duration: 1500, cle });
  horloge(2500);
  await s.surEvenement("ended", { currentTime: 1500, duration: 1500, cle });
  expect(notes).toEqual([
    [1, 1500],
    [2, 1500],
    [1500, 1500],
  ]);
  expect(fins).toEqual([false, false, true]);
});

test("30 s video: nothing noted, nothing resumed", async () => {
  const { s, notes, demandes } = suivi(20);
  const cle = {};
  for (const type of ["loadedmetadata", "play", "timeupdate", "pause", "ended"] as const) {
    expect(await s.surEvenement(type, { currentTime: 12, duration: 30, cle })).toBeNull();
  }
  expect(notes).toEqual([]);
  expect(demandes()).toBe(0);
});

test("non-finite (live) or missing duration: ignored", async () => {
  const { s, notes, demandes } = suivi(100);
  const cle = {};
  for (const duration of [Infinity, NaN]) {
    expect(await s.surEvenement("play", { currentTime: 10, duration, cle })).toBeNull();
    await s.surEvenement("pause", { currentTime: 10, duration, cle });
  }
  expect(notes).toEqual([]);
  expect(demandes()).toBe(0);
});

test("play with known position 1390: returns 1385, only once", async () => {
  const { s, demandes, durees } = suivi(1390);
  const cle = {};
  expect(await s.surEvenement("loadedmetadata", { currentTime: 0, duration: 1500, cle })).toBe(1385);
  expect(durees).toEqual([1500]);
  expect(await s.surEvenement("play", { currentTime: 1385, duration: 1500, cle })).toBeNull();
  expect(await s.surEvenement("loadedmetadata", { currentTime: 1385, duration: 1500, cle })).toBeNull();
  expect(demandes()).toBe(1);
  // Another element of the page (recreated player) asks for itself, with its duration; the main decides whether to serve it.
  expect(await s.surEvenement("play", { currentTime: 0, duration: 1500, cle: {} })).toBe(1385);
  expect(demandes()).toBe(2);
});

test("position 3 : rend 0", async () => {
  const { s } = suivi(3);
  expect(await s.surEvenement("play", { currentTime: 0, duration: 1500, cle: {} })).toBe(0);
});

test("a position beyond this video's duration, or that is not a number: nothing resumed", async () => {
  expect(await suivi(2000).s.surEvenement("play", { currentTime: 0, duration: 1500, cle: {} })).toBeNull();
  expect(await suivi(Number.NaN).s.surEvenement("play", { currentTime: 0, duration: 1500, cle: {} })).toBeNull();
});

test("nothing is noted before the resume is settled: a timeupdate at 0 s does not overwrite the position", async () => {
  const { s, notes, differer, repondre, horloge } = suivi();
  differer();
  const cle = {};
  const reprise = s.surEvenement("play", { currentTime: 0, duration: 1500, cle });
  expect(await s.surEvenement("timeupdate", { currentTime: 0, duration: 1500, cle })).toBeNull();
  expect(await s.surEvenement("pause", { currentTime: 0, duration: 1500, cle })).toBeNull();
  expect(notes).toEqual([]);
  repondre(1390);
  expect(await reprise).toBe(1385);
  horloge(100);
  await s.surEvenement("timeupdate", { currentTime: 1385, duration: 1500, cle });
  expect(notes).toEqual([[1385, 1500]]);
});

test("a request that fails: nothing resumed, the tracking continues", async () => {
  const notes: number[] = [];
  const s = new SuiviReprise({ noter: (t) => void notes.push(t), demander: () => Promise.reject(new Error("x")), maintenant: () => 0 });
  const cle = {};
  expect(await s.surEvenement("play", { currentTime: 0, duration: 1500, cle })).toBeNull();
  await s.surEvenement("pause", { currentTime: 4, duration: 1500, cle });
  expect(notes).toEqual([4]);
});

test("duration known later (stream): the resume is requested at the first event where it is finite", async () => {
  const { s, demandes } = suivi(500);
  const cle = {};
  expect(await s.surEvenement("loadedmetadata", { currentTime: 0, duration: Infinity, cle })).toBeNull();
  expect(await s.surEvenement("timeupdate", { currentTime: 0.2, duration: 1500, cle })).toBe(495);
  expect(demandes()).toBe(1);
});
