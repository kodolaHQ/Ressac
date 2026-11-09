import { expect, test } from "vitest";
import { MIN_RESUME_DURATION_S, POSITION_GAP_MS, RESUME_BACKOFF_S, ResumeTracking } from "../../core/resume";

/** A tracker with a test clock and the position the main process returns. */
function tracking(known: number | null = null) {
  const notes: [number, number][] = [];
  const ends: boolean[] = [];
  const durations: number[] = [];
  let requests = 0;
  let now = 0;
  let response: (p: number | null) => void = () => {};
  let deferred = false;
  const s = new ResumeTracking({
    note: (t, duration, end) => {
      notes.push([t, duration]);
      ends.push(end);
    },
    ask: (duration) => {
      requests++;
      durations.push(duration);
      return deferred ? new Promise((ok) => (response = ok)) : Promise.resolve(known);
    },
    now: () => now,
  });
  return {
    s,
    notes,
    ends: ends,
    durations: durations,
    requests: () => requests,
    clock: (ms: number) => void (now = ms),
    defer: () => void (deferred = true),
    reply: (p: number | null) => response(p),
  };
}

test("the plan's values", () => {
  expect([MIN_RESUME_DURATION_S, POSITION_GAP_MS, RESUME_BACKOFF_S]).toEqual([60, 10_000, 5]);
});

test("timeupdate every second for 35 s: 4 noter (0, 10, 20, 30 s)", async () => {
  const { s, notes, clock: clock } = tracking();
  const key = {};
  expect(await s.onEvent("play", { currentTime: 0, duration: 1500, key: key })).toBeNull();
  for (let t = 0; t <= 35; t++) {
    clock(t * 1000);
    expect(await s.onEvent("timeupdate", { currentTime: t, duration: 1500, key: key })).toBeNull();
  }
  expect(notes).toEqual([
    [0, 1500],
    [10, 1500],
    [20, 1500],
    [30, 1500],
  ]);
});

test("pause: noter right away; ended too, marked as the end", async () => {
  const { s, notes, ends: ends, clock: clock } = tracking();
  const key = {};
  await s.onEvent("play", { currentTime: 0, duration: 1500, key: key });
  await s.onEvent("timeupdate", { currentTime: 1, duration: 1500, key: key });
  clock(2000);
  await s.onEvent("pause", { currentTime: 2, duration: 1500, key: key });
  clock(2500);
  await s.onEvent("ended", { currentTime: 1500, duration: 1500, key: key });
  expect(notes).toEqual([
    [1, 1500],
    [2, 1500],
    [1500, 1500],
  ]);
  expect(ends).toEqual([false, false, true]);
});

test("30 s video: nothing noted, nothing resumed", async () => {
  const { s, notes, requests: requests } = tracking(20);
  const key = {};
  for (const type of ["loadedmetadata", "play", "timeupdate", "pause", "ended"] as const) {
    expect(await s.onEvent(type, { currentTime: 12, duration: 30, key: key })).toBeNull();
  }
  expect(notes).toEqual([]);
  expect(requests()).toBe(0);
});

test("non-finite (live) or missing duration: ignored", async () => {
  const { s, notes, requests: requests } = tracking(100);
  const key = {};
  for (const duration of [Infinity, NaN]) {
    expect(await s.onEvent("play", { currentTime: 10, duration, key: key })).toBeNull();
    await s.onEvent("pause", { currentTime: 10, duration, key: key });
  }
  expect(notes).toEqual([]);
  expect(requests()).toBe(0);
});

test("play with known position 1390: returns 1385, only once", async () => {
  const { s, requests: requests, durations: durations } = tracking(1390);
  const key = {};
  expect(await s.onEvent("loadedmetadata", { currentTime: 0, duration: 1500, key: key })).toBe(1385);
  expect(durations).toEqual([1500]);
  expect(await s.onEvent("play", { currentTime: 1385, duration: 1500, key: key })).toBeNull();
  expect(await s.onEvent("loadedmetadata", { currentTime: 1385, duration: 1500, key: key })).toBeNull();
  expect(requests()).toBe(1);
  // Another element of the page (recreated player) asks for itself, with its duration; the main decides whether to serve it.
  expect(await s.onEvent("play", { currentTime: 0, duration: 1500, key: {} })).toBe(1385);
  expect(requests()).toBe(2);
});

test("position 3: returns 0", async () => {
  const { s } = tracking(3);
  expect(await s.onEvent("play", { currentTime: 0, duration: 1500, key: {} })).toBe(0);
});

test("a position beyond this video's duration, or that is not a number: nothing resumed", async () => {
  expect(await tracking(2000).s.onEvent("play", { currentTime: 0, duration: 1500, key: {} })).toBeNull();
  expect(await tracking(Number.NaN).s.onEvent("play", { currentTime: 0, duration: 1500, key: {} })).toBeNull();
});

test("nothing is noted before the resume is settled: a timeupdate at 0 s does not overwrite the position", async () => {
  const { s, notes, defer: defer, reply: reply, clock: clock } = tracking();
  defer();
  const key = {};
  const resume = s.onEvent("play", { currentTime: 0, duration: 1500, key: key });
  expect(await s.onEvent("timeupdate", { currentTime: 0, duration: 1500, key: key })).toBeNull();
  expect(await s.onEvent("pause", { currentTime: 0, duration: 1500, key: key })).toBeNull();
  expect(notes).toEqual([]);
  reply(1390);
  expect(await resume).toBe(1385);
  clock(100);
  await s.onEvent("timeupdate", { currentTime: 1385, duration: 1500, key: key });
  expect(notes).toEqual([[1385, 1500]]);
});

test("a request that fails: nothing resumed, the tracking continues", async () => {
  const notes: number[] = [];
  const s = new ResumeTracking({ note: (t) => void notes.push(t), ask: () => Promise.reject(new Error("x")), now: () => 0 });
  const key = {};
  expect(await s.onEvent("play", { currentTime: 0, duration: 1500, key: key })).toBeNull();
  await s.onEvent("pause", { currentTime: 4, duration: 1500, key: key });
  expect(notes).toEqual([4]);
});

test("duration known later (stream): the resume is requested at the first event where it is finite", async () => {
  const { s, requests: requests } = tracking(500);
  const key = {};
  expect(await s.onEvent("loadedmetadata", { currentTime: 0, duration: Infinity, key: key })).toBeNull();
  expect(await s.onEvent("timeupdate", { currentTime: 0.2, duration: 1500, key: key })).toBe(495);
  expect(requests()).toBe(1);
});
