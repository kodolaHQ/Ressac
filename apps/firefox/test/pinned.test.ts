import { describe, expect, it } from "vitest";
import { parsePinned, setPinned } from "../chrome/window/pinned";

describe("pinned add-ons", () => {
  it("unreadable pref is no pin", () => {
    expect(parsePinned("")).toEqual([]);
    expect(parsePinned("{")).toEqual([]);
    expect(parsePinned("[1]")).toEqual([]);
  });

  it("pin appends once, unpin removes", () => {
    expect(setPinned(["a"], "b", true)).toEqual(["a", "b"]);
    expect(setPinned(["a", "b"], "a", true)).toEqual(["a", "b"]);
    expect(setPinned(["a", "b"], "a", false)).toEqual(["b"]);
  });
});
