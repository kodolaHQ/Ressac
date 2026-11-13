import { expect, test } from "vitest";
import { createActivity } from "../../core/agent/activity";

const clock = () => {
  let t = 0;
  return { now: () => t, advance: (ms: number) => (t += ms) };
};

test("an event shows the tab with its label", () => {
  const c = clock();
  const a = createActivity(c.now);
  expect(a.state()).toBeNull();
  a.event({ tab: "t1", label: "Lit leboncoin.fr" });
  expect(a.state()).toEqual({ tab: "t1", label: "Lit leboncoin.fr", running: false });
});

test("stays 20 s after the last tool ends, then goes", () => {
  const c = clock();
  const a = createActivity(c.now);
  a.event({ tab: "t1", label: "Lit leboncoin.fr" });
  a.running("t1", true);
  c.advance(60_000);
  expect(a.state()?.running).toBe(true);
  a.running("t1", false);
  c.advance(19_000);
  expect(a.state()).toEqual({ tab: "t1", label: "Lit leboncoin.fr", running: false });
  c.advance(2_000);
  expect(a.state()).toBeNull();
});

test("a new event on another tab moves it", () => {
  const c = clock();
  const a = createActivity(c.now);
  a.event({ tab: "t1", label: "Lit leboncoin.fr" });
  a.event({ tab: "t2", label: "Va sur exemple.fr" });
  expect(a.state()).toMatchObject({ tab: "t2", label: "Va sur exemple.fr" });
});

test("a closed tab is no longer shown", () => {
  const c = clock();
  const a = createActivity(c.now);
  a.event({ tab: "t1", label: "Lit leboncoin.fr" });
  a.running("t1", true);
  a.closed("t1");
  expect(a.state()).toBeNull();
  // A late end of its tool brings nothing back.
  a.running("t1", false);
  expect(a.state()).toBeNull();
});

test("remaining() is the time left of the hold", () => {
  const c = clock();
  const a = createActivity(c.now);
  a.event({ tab: "t1", label: "Lit leboncoin.fr" });
  a.running("t1", true);
  expect(a.remaining()).toBe(20_000);
  a.running("t1", false);
  c.advance(15_000);
  expect(a.remaining()).toBe(5_000);
  c.advance(10_000);
  expect(a.remaining()).toBe(0);
});
