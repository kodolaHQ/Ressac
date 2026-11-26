import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { createEngineHistory, historyCommand } from "../../host/chat-history";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const UUID = "0f8c2b9e-1d2a-4c3b-9a8b-7c6d5e4f3a2b";

test("historyCommand: the id is its own argument, and only a strict id shape is accepted", () => {
  const claude = historyCommand({ engine: "claude", id: UUID })!;
  expect(claude[0]).toBe("find");
  expect(claude).toContain(`${UUID}.jsonl`);
  expect(claude).toContain(UUID);
  const codex = historyCommand({ engine: "codex", id: "019a-thread_1" })!;
  expect(codex).toContain("*-019a-thread_1.jsonl");
  for (const id of ["../x", "-rf", "*", "a*b", "a?b", "a/b", "", " x", UUID.toUpperCase().replace(/-/g, "")]) {
    expect(historyCommand({ engine: "claude", id })).toBeNull();
  }
  for (const id of ["../x", "-rf", "*", "a*b", "[a]", "a/b", "", "_x"]) expect(historyCommand({ engine: "codex", id })).toBeNull();
});

function prepare(started: boolean) {
  const dir = mkdtempSync(join(tmpdir(), "ressac-history-"));
  dirs.push(dir);
  const execs: string[][] = [];
  const w = { started, code: 0 };
  const history = createEngineHistory({
    file: join(dir, "chats", "engine-history-pending.json"),
    workshop: {
      state: async () => (w.started ? "started" : "stopped"),
      exec: async (argv) => (execs.push(argv), { code: w.code, stdout: "", stderr: w.code ? "boom" : "" }),
    },
  });
  return { dir, execs, w, history, pending: () => JSON.parse(readFileSync(join(dir, "chats", "engine-history-pending.json"), "utf8")) };
}

test("workshop running: the deletion runs at once", async () => {
  const { execs, history } = prepare(true);
  expect(await history.forget({ engine: "claude", id: UUID })).toBe("done");
  expect(execs).toEqual([historyCommand({ engine: "claude", id: UUID })]);
});

test("workshop stopped: never started, kept for its next start and replayed then", async () => {
  const { execs, w, history, pending, dir } = prepare(false);
  expect(await history.forget({ engine: "codex", id: "thread-1" })).toBe("pending");
  expect(await history.forget({ engine: "claude", id: UUID })).toBe("pending");
  expect(execs).toEqual([]);
  expect(pending()).toEqual([{ engine: "codex", id: "thread-1" }, { engine: "claude", id: UUID }]);
  w.started = true;
  w.code = 1; // a failure stays for the next start
  await history.replay();
  expect(pending()).toHaveLength(2);
  w.code = 0;
  await history.replay();
  expect(execs).toHaveLength(4);
  expect(existsSync(join(dir, "chats", "engine-history-pending.json"))).toBe(false);
});

test("a refused id is neither run nor kept; a failed run says so", async () => {
  const { execs, w, history } = prepare(true);
  expect(await history.forget({ engine: "claude", id: "../x" })).toBe("failed");
  w.code = 1;
  expect(await history.forget({ engine: "claude", id: UUID })).toBe("failed");
  expect(execs).toHaveLength(1);
});
