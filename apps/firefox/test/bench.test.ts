import { describe, expect, it } from "vitest";
import { compare, median, type BenchFile } from "../scripts/bench-stats.ts";

const file = (app: BenchFile["app"], measures: Record<string, number[]>): BenchFile => ({ app, headed: false, measures });
const row = (rows: ReturnType<typeof compare>, m: string) => rows.find((r) => r.measure === m)!;

describe("bench stats", () => {
  it("median of an even list is the mean of the middle two", () => {
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it("pools the three runs per app", () => {
    const rows = compare([
      file("electron", { switch: [1, 2] }), file("electron", { switch: [3] }), file("electron", { switch: [4, 5] }),
      file("firefox", { switch: [10] }), file("firefox", { switch: [20] }), file("firefox", { switch: [30] }),
    ]);
    expect(row(rows, "switch")).toMatchObject({ electron: 3, firefox: 20 });
  });

  it("invisibleReadNet subtracts the 2 s calm", () => {
    const rows = compare([file("electron", { invisibleRead: [2100, 2300] }), file("firefox", { invisibleRead: [2200] })]);
    expect(row(rows, "invisibleReadNet")).toMatchObject({ electron: 200, firefox: 200 });
    expect(row(rows, "invisibleRead").verdict).toBe("info");
  });

  it("10 % is ok, 10.1 % is too slow", () => {
    const v = (f: number) => row(compare([file("electron", { m: [100] }), file("firefox", { m: [f] })]), "m");
    expect(v(110).verdict).toBe("ok");
    expect(v(110.1).verdict).toBe("too slow");
  });

  it("a measure only one app has is info", () => {
    const r = row(compare([file("electron", { m: [1] }), file("firefox", {})]), "m");
    expect(r).toMatchObject({ firefox: null, ratio: null, verdict: "info" });
  });
});
