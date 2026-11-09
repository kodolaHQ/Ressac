import { expect, test } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODE_CANCELLED, CODE_TIMEOUT_EXCEEDED, defaultRunner } from "../../src/conteneur/executeur.js";

test("a non-zero code is returned as is, without disguising stderr", async () => {
  expect(await defaultRunner("sh", ["-c", "echo sortie; exit 3"])).toEqual({ code: 3, stdout: "sortie\n", stderr: "" });
});

test("commande introuvable → 127", async () => {
  expect((await defaultRunner("commande-qui-n-existe-pas", [])).code).toBe(127);
});

test("timeout exceeded → 124", async () => {
  expect((await defaultRunner("sleep", ["5"], { delaiMs: 100 })).code).toBe(CODE_TIMEOUT_EXCEEDED);
});

const vivant = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const attendreVrai = async (f: () => boolean, ms = 5000) => {
  const fin = Date.now() + ms;
  while (!f() && Date.now() < fin) await new Promise((r) => setTimeout(r, 20));
  return f();
};

test("cancelled (signal): the whole group is killed, children included, and the result says « annulé »", async () => {
  const dossier = await mkdtemp(join(tmpdir(), "executeur-"));
  const fichier = join(dossier, "pid");
  const controleur = new AbortController();
  // sh launches a child (like git launches git-remote-https) and writes its pid.
  const r = defaultRunner("sh", ["-c", `sleep 300 & echo $! > ${fichier}; wait`], { signal: controleur.signal });
  expect(await attendreVrai(() => existsSync(fichier) && readFileSync(fichier, "utf8").trim() !== "")).toBe(true);
  const pid = Number(readFileSync(fichier, "utf8"));
  expect(vivant(pid)).toBe(true);
  controleur.abort();
  expect((await r).code).toBe(CODE_CANCELLED);
  expect(await attendreVrai(() => !vivant(pid))).toBe(true);
});

test("an already-cancelled signal launches nothing", async () => {
  const dossier = await mkdtemp(join(tmpdir(), "executeur-"));
  const controleur = new AbortController();
  controleur.abort();
  const r = await defaultRunner("sh", ["-c", `touch ${join(dossier, "lance")}`], { signal: controleur.signal });
  expect(r.code).toBe(CODE_CANCELLED);
  expect(existsSync(join(dossier, "lance"))).toBe(false);
});

test("with a (non-cancelled) signal: output, code, timeout and command not found stay the same", async () => {
  const signal = new AbortController().signal;
  expect(await defaultRunner("sh", ["-c", "echo sortie; echo err >&2; exit 3"], { signal })).toEqual({ code: 3, stdout: "sortie\n", stderr: "err\n" });
  expect((await defaultRunner("commande-qui-n-existe-pas", [], { signal })).code).toBe(127);
  expect((await defaultRunner("sleep", ["5"], { delaiMs: 100, signal })).code).toBe(CODE_TIMEOUT_EXCEEDED);
});
