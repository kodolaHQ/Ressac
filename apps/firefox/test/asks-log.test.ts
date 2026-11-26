import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { askScope, noted, type AskLine } from "../../../packages/kernel/src/index";
import { asksLog } from "../host/asks-log";

let root: string;
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

test("one stdout line and one JSON line per card and per answer, in a logs folder it creates; no query, no text", async () => {
  root = mkdtempSync(join(tmpdir(), "ressac-asks-"));
  const file = join(root, "logs", "asks.jsonl");
  const out = vi.spyOn(console, "error").mockImplementation(() => {});
  const sink = asksLog(file);
  await askScope.run({ tool: "read_tab", chat: "c1" }, () =>
    noted(sink, { kind: "read-tab", rule: "tab-not-granted", url: "https://bank.example/accounts/98765432?iban=FR7630001007941234567890185#top" }, async () => false, Boolean),
  );
  const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l) as AskLine);
  expect(lines).toHaveLength(2);
  expect(lines[0]).toMatchObject({ kind: "read-tab", rule: "tab-not-granted", tool: "read_tab", chat: "c1", site: "bank.example", path: "/accounts/:x" });
  expect(lines[1]).toMatchObject({ id: lines[0]!.id, answer: "refuse" });
  expect(out.mock.calls[0]![0]).toMatch(/^\[ressac\] ask \w{8} read-tab tab-not-granted bank\.example\/accounts\/:x \(read_tab\)$/);
  const all = readFileSync(file, "utf8") + out.mock.calls.flat().join("\n");
  for (const leak of ["iban", "FR76", "98765432", "#top"]) expect(all).not.toContain(leak);
});

test("past its cap, the oldest half of the lines goes", () => {
  root = mkdtempSync(join(tmpdir(), "ressac-asks-"));
  const file = join(root, "asks.jsonl");
  vi.spyOn(console, "error").mockImplementation(() => {});
  const sink = asksLog(file, 2_000);
  for (let i = 0; i < 40; i++) sink({ id: `id-${String(i).padStart(4, "0")}`, ts: "t", answer: "refuse", ms: i });
  const ids = readFileSync(file, "utf8").trim().split("\n").map((l) => (JSON.parse(l) as { id: string }).id);
  expect(readFileSync(file).length).toBeLessThanOrEqual(2_000);
  expect(ids.at(-1)).toBe("id-0039");
  expect(ids[0]).not.toBe("id-0000");
});
