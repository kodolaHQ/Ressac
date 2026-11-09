import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGrouper } from "../core/onglets/regroupeur";

describe("regroupeur", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("groups two close schedulings into a single call", () => {
    const faire = vi.fn();
    const r = createGrouper(1000, faire);
    r.planifier("a");
    vi.advanceTimersByTime(500);
    r.planifier("a");
    vi.advanceTimersByTime(999);
    expect(faire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(faire).toHaveBeenCalledTimes(1);
    expect(faire).toHaveBeenCalledWith("a");
  });

  it("forgetting before the deadline cancels the call", () => {
    const faire = vi.fn();
    const r = createGrouper(1000, faire);
    r.planifier("a");
    r.oublier("a");
    vi.advanceTimersByTime(5000);
    expect(faire).not.toHaveBeenCalled();
  });
});
