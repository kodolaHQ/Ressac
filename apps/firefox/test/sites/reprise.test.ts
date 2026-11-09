import { expect, test } from "vitest";
import { MIN_RESUME_DURATION_S, POSITION_GAP_MS, RESUME_BACKOFF_S, ResumeTracking } from "../../core/reprise";

/** A tracker with a test clock and the position the main process returns. */
function tracking(known: number | null = null) {
  const notes: [number, number][] = [];
  const fins: boolean[] = [];
  const durations: number[] = [];
  let requests = 0;
  let now = 0;
  let response: (p: number | null) => void = () => {};
  let deferred = false;
  const s = new ResumeTracking({
    noter: (t, duration, fin) => {
      notes.push([t, duration]);
      fins.push(fin);
    },
    demander: (duration) => {
      requests++;
      durations.push(duration);
      return deferred ? new Promise((ok) => (response = ok)) : Promise.resolve(known);
    },
    maintenant: () => now,
  });
  return {
    s,
    notes,
    fins,
    durees: durations,
    demandes: () => requests,
    horloge: (ms: number) => void (now = ms),
    differer: () => void (deferred = true),
    repondre: (p: number | null) => response(p),
  };
}

test("the plan's values", () => {
  expect([MIN_RESUME_DURATION_S, POSITION_GAP_MS, RESUME_BACKOFF_S]).toEqual([60, 10_000, 5]);
});

test("timeupdate every second for 35 s: 4 noter (0, 10, 20, 30 s)", async () => {
  const { s, notes, horloge: clock } = tracking();
  const key = {};
  expect(await s.surEvenement("play", { currentTime: 0, duration: 1500, cle: key })).toBeNull();
  for (let t = 0; t <= 35; t++) {
    clock(t * 1000);
    expect(await s.surEvenement("timeupdate", { currentTime: t, duration: 1500, cle: key })).toBeNull();
  }
  expect(notes).toEqual([
    [0, 1500],
    [10, 1500],
    [20, 1500],
    [30, 1500],
  ]);
});

test("pause: noter right away; ended too, marked as the end", async () => {
  const { s, notes, fins, horloge: clock } = tracking();
  const key = {};
  await s.surEvenement("play", { currentTime: 0, duration: 1500, cle: key });
  await s.surEvenement("timeupdate", { currentTime: 1, duration: 1500, cle: key });
  clock(2000);
  await s.surEvenement("pause", { currentTime: 2, duration: 1500, cle: key });
  clock(2500);
  await s.surEvenement("ended", { currentTime: 1500, duration: 1500, cle: key });
  expect(notes).toEqual([
    [1, 1500],
    [2, 1500],
    [1500, 1500],
  ]);
  expect(fins).toEqual([false, false, true]);
});

test("30 s video: nothing noted, nothing resumed", async () => {
  const { s, notes, demandes: requests } = tracking(20);
  const key = {};
  for (const type of ["loadedmetadata", "play", "timeupdate", "pause", "ended"] as const) {
    expect(await s.surEvenement(type, { currentTime: 12, duration: 30, cle: key })).toBeNull();
  }
  expect(notes).toEqual([]);
  expect(requests()).toBe(0);
});

test("non-finite (live) or missing duration: ignored", async () => {
  const { s, notes, demandes: requests } = tracking(100);
  const key = {};
  for (const duration of [Infinity, NaN]) {
    expect(await s.surEvenement("play", { currentTime: 10, duration, cle: key })).toBeNull();
    await s.surEvenement("pause", { currentTime: 10, duration, cle: key });
  }
  expect(notes).toEqual([]);
  expect(requests()).toBe(0);
});

test("play with known position 1390: returns 1385, only once", async () => {
  const { s, demandes: requests, durees: durations } = tracking(1390);
  const key = {};
  expect(await s.surEvenement("loadedmetadata", { currentTime: 0, duration: 1500, cle: key })).toBe(1385);
  expect(durations).toEqual([1500]);
  expect(await s.surEvenement("play", { currentTime: 1385, duration: 1500, cle: key })).toBeNull();
  expect(await s.surEvenement("loadedmetadata", { currentTime: 1385, duration: 1500, cle: key })).toBeNull();
  expect(requests()).toBe(1);
  // Another element of the page (recreated player) asks for itself, with its duration; the main decides whether to serve it.
  expect(await s.surEvenement("play", { currentTime: 0, duration: 1500, cle: {} })).toBe(1385);
  expect(requests()).toBe(2);
});

test("position 3: returns 0", async () => {
  const { s } = tracking(3);
  expect(await s.surEvenement("play", { currentTime: 0, duration: 1500, cle: {} })).toBe(0);
});

test("a position beyond this video's duration, or that is not a number: nothing resumed", async () => {
  expect(await tracking(2000).s.surEvenement("play", { currentTime: 0, duration: 1500, cle: {} })).toBeNull();
  expect(await tracking(Number.NaN).s.surEvenement("play", { currentTime: 0, duration: 1500, cle: {} })).toBeNull();
});

test("nothing is noted before the resume is settled: a timeupdate at 0 s does not overwrite the position", async () => {
  const { s, notes, differer: defer, repondre: reply, horloge: clock } = tracking();
  defer();
  const key = {};
  const reprise = s.surEvenement("play", { currentTime: 0, duration: 1500, cle: key });
  expect(await s.surEvenement("timeupdate", { currentTime: 0, duration: 1500, cle: key })).toBeNull();
  expect(await s.surEvenement("pause", { currentTime: 0, duration: 1500, cle: key })).toBeNull();
  expect(notes).toEqual([]);
  reply(1390);
  expect(await reprise).toBe(1385);
  clock(100);
  await s.surEvenement("timeupdate", { currentTime: 1385, duration: 1500, cle: key });
  expect(notes).toEqual([[1385, 1500]]);
});

test("a request that fails: nothing resumed, the tracking continues", async () => {
  const notes: number[] = [];
  const s = new ResumeTracking({ noter: (t) => void notes.push(t), demander: () => Promise.reject(new Error("x")), maintenant: () => 0 });
  const key = {};
  expect(await s.surEvenement("play", { currentTime: 0, duration: 1500, cle: key })).toBeNull();
  await s.surEvenement("pause", { currentTime: 4, duration: 1500, cle: key });
  expect(notes).toEqual([4]);
});

test("duration known later (stream): the resume is requested at the first event where it is finite", async () => {
  const { s, demandes: requests } = tracking(500);
  const key = {};
  expect(await s.surEvenement("loadedmetadata", { currentTime: 0, duration: Infinity, cle: key })).toBeNull();
  expect(await s.surEvenement("timeupdate", { currentTime: 0.2, duration: 1500, cle: key })).toBe(495);
  expect(requests()).toBe(1);
});
