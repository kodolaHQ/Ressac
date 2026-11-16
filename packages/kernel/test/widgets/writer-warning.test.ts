import { describe, it, expect } from "vitest";
import { writerWarning } from "../../src/widgets/harvest.js";
import { say } from "../../src/i18n.js";
import type { Execution } from "../../src/workflows/executions.js";

const run = (...log: string[]) => ({ blocks: [{ log }] }) as unknown as Execution;

describe("writerWarning", () => {
  it("returns the kernel writer message of a failed item, in the shown language", () => {
    expect(writerWarning(run(`élément 1 : ${say("fr", "kernel-writer-none")}`), "en")).toBe(say("en", "kernel-writer-none"));
    expect(writerWarning(run("autre", `élément 2 : ${say("en", "kernel-writer-limit")}`), "fr")).toBe(say("fr", "kernel-writer-limit"));
  });
  it("ignores any other item error (it may carry account data) and clean runs", () => {
    expect(writerWarning(run("élément 1 : secret@example.com a échoué"), "fr")).toBeUndefined();
    expect(writerWarning(run(`élément 1 : ${say("fr", "kernel-writer-failed", { reason: "x" })}`), "fr")).toBeUndefined();
    expect(writerWarning(run(), "fr")).toBeUndefined();
  });
});
