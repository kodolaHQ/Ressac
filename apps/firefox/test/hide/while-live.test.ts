import { expect, it, vi } from "vitest";
import { whileLive } from "../../core/hide/marks";

// A walk in flight when the marks stop: its text nodes are let go and nothing of it is kept.
it("gives the answer while live", async () => {
  const release = vi.fn();
  expect(await whileLive(() => true, async () => 1, release)).toBe(1);
  expect(release).not.toHaveBeenCalled();
});
it("releases and gives null when stopped during the step", async () => {
  let stopped = false;
  const release = vi.fn();
  const p = whileLive(() => !stopped, async () => 1, release);
  stopped = true;
  expect(await p).toBeNull();
  expect(release).toHaveBeenCalledTimes(1);
});
