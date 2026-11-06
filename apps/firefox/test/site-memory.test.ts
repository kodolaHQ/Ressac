import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, test } from "vitest";
import { CLE_INVALIDE, MemoireSite, VALEUR_NON_JSON } from "../../../packages/noyau/src/index";
import { memoireOp, REFUS_MEMOIRE } from "../noyau/site-memory";

// The memory part of Electron's test/sites/injection.test.ts, ported to the host's memoireOp: the sender checks
// (sub-frame, sign-in window, page off the site, no accord) are the chrome's, in site-frames.test.ts.

let memoire: MemoireSite;
let refusee: boolean;
const op = (d: object) => memoireOp(async () => {
  if (refusee) throw new Error("appli de site en cours de suppression : vidola");
  return memoire;
}, { id: "vidola", adresse: "/series/x", ...d });

beforeEach(async () => {
  refusee = false;
  memoire = await MemoireSite.ouvrir(mkdtempSync(join(tmpdir(), "site-memory-")), "vidola");
});

test("retenir takes the address the chrome gives; lire, oublier", async () => {
  expect(await op({ op: "retenir", cle: "encours.the-bear", valeur: { titre: "The Bear" }, adresse: "/serie/the-bear?e=4" })).toEqual({ ok: true });
  expect(memoire.contenu().valeurs["encours.the-bear"]).toMatchObject({ valeur: { titre: "The Bear" }, adresse: "/serie/the-bear?e=4" });
  expect(await op({ op: "lire", cle: "encours.the-bear" })).toEqual({ ok: true, valeur: { titre: "The Bear" } });
  expect(await op({ op: "lire", cle: "absente" })).toEqual({ ok: true, valeur: null });
  expect(await op({ op: "oublier", cle: "encours.the-bear" })).toEqual({ ok: true });
  expect(memoire.contenu().valeurs).toEqual({});
});

test("the memory's named refusals (key, non-JSON value)", async () => {
  expect(await op({ op: "retenir", cle: "", valeur: 1 })).toEqual({ ok: false, erreur: CLE_INVALIDE });
  expect(await op({ op: "retenir", cle: "x", valeur: undefined })).toEqual({ ok: false, erreur: VALEUR_NON_JSON });
});

test("a malformed request is refused, nothing written", async () => {
  for (const d of [{ op: "effacer", cle: "x" }, { op: "lire", cle: 3 }, { op: "retenir", cle: "x", valeur: 1, adresse: 4 }, { op: "retenir", cle: "x", valeur: 1, id: null }])
    expect(await op(d)).toEqual({ ok: false, erreur: REFUS_MEMOIRE });
  for (const d of [null, "x", 3]) expect(await memoireOp(async () => memoire, d)).toEqual({ ok: false, erreur: REFUS_MEMOIRE });
  expect(memoire.contenu().valeurs).toEqual({});
});

test("memory refused by the service (app being deleted): the memory's refusal, nothing written", async () => {
  refusee = true;
  for (const o of ["retenir", "lire", "oublier"]) expect(await op({ op: o, cle: "x", valeur: 1 })).toEqual({ ok: false, erreur: REFUS_MEMOIRE });
  expect(memoire.contenu().valeurs).toEqual({});
});

test("the copied refusal and request shape are Electron's (main/sites/injection.ts)", () => {
  const electron = readFileSync(join(import.meta.dirname, "../../navigateur/src/main/sites/injection.ts"), "utf8");
  const ours = readFileSync(join(import.meta.dirname, "../noyau/site-memory.ts"), "utf8");
  expect(electron).toContain(`const REFUS_MEMOIRE = ${JSON.stringify(REFUS_MEMOIRE)};`);
  const fn = (src: string) => src.slice(src.indexOf("function demandeMemoire"), src.indexOf("\n}\n", src.indexOf("function demandeMemoire")));
  expect(fn(ours)).toBe(fn(electron));
});
