import { describe, expect, it, vi } from "vitest";
import { runsMemo } from "../../core/hide/marks";

// The marks walk the page every second: the kernel is asked again only when the key or the text changed, or after a clear.
describe("runsMemo", () => {
  const r = [{ start: 0, end: 3 }];
  it("reuses the runs for the same key and text", async () => {
    const m = runsMemo();
    const ask = vi.fn(async () => r);
    expect(await m.get("k", "abc", ask)).toBe(r);
    expect(await m.get("k", "abc", ask)).toBe(r);
    expect(ask).toHaveBeenCalledTimes(1);
  });
  it("asks again on another key, another text, or after a clear", async () => {
    const m = runsMemo();
    const ask = vi.fn(async () => r);
    await m.get("k", "abc", ask);
    await m.get("k2", "abc", ask);
    await m.get("k2", "abcd", ask);
    m.clear();
    await m.get("k2", "abcd", ask);
    expect(ask).toHaveBeenCalledTimes(4);
  });
  it("keeps no answer asked across a clear", async () => {
    const m = runsMemo();
    let done!: (x: typeof r) => void;
    const p = m.get("k", "abc", () => new Promise((res) => (done = res)));
    m.clear();
    done(r);
    expect(await p).toBe(r);
    const ask = vi.fn(async () => []);
    await m.get("k", "abc", ask);
    expect(ask).toHaveBeenCalledTimes(1);
  });
});
