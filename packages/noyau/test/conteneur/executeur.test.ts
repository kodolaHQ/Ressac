import { expect, test } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODE_ANNULE, CODE_DELAI_DEPASSE, executeurParDefaut } from "../../src/conteneur/executeur.js";

test("un code non nul est renvoyé tel quel, sans maquiller stderr", async () => {
  expect(await executeurParDefaut("sh", ["-c", "echo sortie; exit 3"])).toEqual({ code: 3, stdout: "sortie\n", stderr: "" });
});

test("commande introuvable → 127", async () => {
  expect((await executeurParDefaut("commande-qui-n-existe-pas", [])).code).toBe(127);
});

test("délai dépassé → 124", async () => {
  expect((await executeurParDefaut("sleep", ["5"], { delaiMs: 100 })).code).toBe(CODE_DELAI_DEPASSE);
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

test("annulé (signal) : tout le groupe est tué, enfants compris, et le résultat dit « annulé »", async () => {
  const dossier = await mkdtemp(join(tmpdir(), "executeur-"));
  const fichier = join(dossier, "pid");
  const controleur = new AbortController();
  // sh lance un enfant (comme git lance git-remote-https) et écrit son pid.
  const r = executeurParDefaut("sh", ["-c", `sleep 300 & echo $! > ${fichier}; wait`], { signal: controleur.signal });
  expect(await attendreVrai(() => existsSync(fichier) && readFileSync(fichier, "utf8").trim() !== "")).toBe(true);
  const pid = Number(readFileSync(fichier, "utf8"));
  expect(vivant(pid)).toBe(true);
  controleur.abort();
  expect((await r).code).toBe(CODE_ANNULE);
  expect(await attendreVrai(() => !vivant(pid))).toBe(true);
});

test("un signal déjà annulé ne lance rien", async () => {
  const dossier = await mkdtemp(join(tmpdir(), "executeur-"));
  const controleur = new AbortController();
  controleur.abort();
  const r = await executeurParDefaut("sh", ["-c", `touch ${join(dossier, "lance")}`], { signal: controleur.signal });
  expect(r.code).toBe(CODE_ANNULE);
  expect(existsSync(join(dossier, "lance"))).toBe(false);
});

test("avec un signal (non annulé) : sortie, code, délai et commande introuvable restent les mêmes", async () => {
  const signal = new AbortController().signal;
  expect(await executeurParDefaut("sh", ["-c", "echo sortie; echo err >&2; exit 3"], { signal })).toEqual({ code: 3, stdout: "sortie\n", stderr: "err\n" });
  expect((await executeurParDefaut("commande-qui-n-existe-pas", [], { signal })).code).toBe(127);
  expect((await executeurParDefaut("sleep", ["5"], { delaiMs: 100, signal })).code).toBe(CODE_DELAI_DEPASSE);
});
