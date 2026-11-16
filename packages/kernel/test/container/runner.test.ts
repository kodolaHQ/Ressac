import { expect, test } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODE_CANCELLED, CODE_TIMEOUT_EXCEEDED, createRunner, defaultRunner } from "../../src/container/runner.js";

test("a non-zero code is returned as is, without disguising stderr", async () => {
  expect(await defaultRunner("sh", ["-c", "echo sortie; exit 3"])).toEqual({ code: 3, stdout: "sortie\n", stderr: "" });
});

test("commande introuvable → 127", async () => {
  expect((await defaultRunner("commande-qui-n-existe-pas", [])).code).toBe(127);
});

test("timeout exceeded → 124", async () => {
  expect((await defaultRunner("sleep", ["5"], { delayMs: 100 })).code).toBe(CODE_TIMEOUT_EXCEEDED);
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const waitUntilTrue = async (f: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!f() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  return f();
};

test("cancelled (signal): the whole group is killed, children included, and the result says « annulé »", async () => {
  const folder = await mkdtemp(join(tmpdir(), "executeur-"));
  const file = join(folder, "pid");
  const controller = new AbortController();
  // sh launches a child (like git launches git-remote-https) and writes its pid.
  const r = defaultRunner("sh", ["-c", `sleep 300 & echo $! > ${file}; wait`], { signal: controller.signal });
  expect(await waitUntilTrue(() => existsSync(file) && readFileSync(file, "utf8").trim() !== "")).toBe(true);
  const pid = Number(readFileSync(file, "utf8"));
  expect(alive(pid)).toBe(true);
  controller.abort();
  expect((await r).code).toBe(CODE_CANCELLED);
  expect(await waitUntilTrue(() => !alive(pid))).toBe(true);
});

test("an already-cancelled signal launches nothing", async () => {
  const folder = await mkdtemp(join(tmpdir(), "executeur-"));
  const controller = new AbortController();
  controller.abort();
  const r = await defaultRunner("sh", ["-c", `touch ${join(folder, "lance")}`], { signal: controller.signal });
  expect(r.code).toBe(CODE_CANCELLED);
  expect(existsSync(join(folder, "lance"))).toBe(false);
});

test("with a (non-cancelled) signal: output, code, timeout and command not found stay the same", async () => {
  const signal = new AbortController().signal;
  expect(await defaultRunner("sh", ["-c", "echo sortie; echo err >&2; exit 3"], { signal })).toEqual({ code: 3, stdout: "sortie\n", stderr: "err\n" });
  expect((await defaultRunner("commande-qui-n-existe-pas", [], { signal })).code).toBe(127);
  expect((await defaultRunner("sleep", ["5"], { delayMs: 100, signal })).code).toBe(CODE_TIMEOUT_EXCEEDED);
});

test("the runner's own texts follow its locale getter", async () => {
  const fr = createRunner(() => "fr");
  const en = createRunner(() => "en");
  expect((await fr("ressac-absent-command", [])).stderr).toBe("ressac-absent-command introuvable");
  expect((await en("ressac-absent-command", [])).stderr).toBe("ressac-absent-command not found");
  expect((await fr("sleep", ["5"], { delayMs: 100 })).stderr).toBe("Délai dépassé");
  expect((await en("sleep", ["5"], { delayMs: 100 })).stderr).toBe("Timed out");
  const signal = AbortSignal.abort();
  expect((await fr("sleep", ["5"], { signal })).stderr).toBe("Annulé");
  expect((await en("sleep", ["5"], { signal })).stderr).toBe("Cancelled");
});

test("input with a signal reaches the command's stdin", async () => {
  const r = await defaultRunner("cat", [], { input: "hello", signal: new AbortController().signal });
  expect(r).toEqual({ code: 0, stdout: "hello", stderr: "" });
});

test("input with a signal: cancelling a running command gives CODE_CANCELLED", async () => {
  const c = new AbortController();
  const p = defaultRunner("sh", ["-c", "cat; sleep 5"], { input: "x", signal: c.signal });
  setTimeout(() => c.abort(), 200);
  expect((await p).code).toBe(CODE_CANCELLED);
});
