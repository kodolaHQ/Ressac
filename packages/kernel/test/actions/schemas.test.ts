import { expect, test } from "vitest";
import { DeclarationAction, ID_ACTION, WEB_WITH_ACCOUNT } from "../../src/index.js";

const message = (raw: unknown) => {
  const r = DeclarationAction.safeParse(raw);
  return r.success ? null : r.error.issues.map((i) => i.message).join(" | ");
};

test("the GitLab example (gitlab.com account, motsCles, miseEnPage) is accepted", () => {
  const d = DeclarationAction.parse({
    nom: "Mes merge requests",
    description: "Les merge requests qui m'attendent",
    motsCles: ["gitlab", "mr", "revue"],
    sources: { compte: ["gitlab.com"] },
    miseEnPage: "Un tableau par projet, les plus anciennes d'abord",
  });
  expect(d.sources).toEqual({ compte: ["gitlab.com"], publiques: [], web: false });
  expect(d.saisie).toBeUndefined();
});

test("the Leboncoin example (web, input « Recherche ») is accepted", () => {
  const d = DeclarationAction.parse({ nom: "Leboncoin", sources: { web: true }, saisie: { libelle: "Recherche" }, dureeMaxMinutes: 10 });
  expect(d.saisie).toEqual({ libelle: "Recherche" });
  expect(d.description).toBe("");
  expect(d.motsCles).toEqual([]);
});

test("web with an account: WEB_AVEC_COMPTE", () => {
  expect(message({ nom: "X", sources: { web: true, compte: ["gitlab.com"] } })).toBe(WEB_WITH_ACCOUNT);
});

test("unknown key (recolte, tailles) refused", () => {
  expect(message({ nom: "X", sources: {}, recolte: { minutes: 30 } })).not.toBeNull();
  expect(message({ nom: "X", sources: {}, tailles: {} })).not.toBeNull();
  expect(message({ nom: "X", sources: {}, saisie: { libelle: "R", defaut: "x" } })).not.toBeNull();
});

test("11 keywords, 41-character label, dureeMaxMinutes 61 refused", () => {
  const base = { nom: "X", sources: {} };
  expect(DeclarationAction.safeParse({ ...base, motsCles: Array.from({ length: 10 }, (_, i) => `m${i}`) }).success).toBe(true);
  expect(DeclarationAction.safeParse({ ...base, motsCles: Array.from({ length: 11 }, (_, i) => `m${i}`) }).success).toBe(false);
  expect(DeclarationAction.safeParse({ ...base, motsCles: ["x".repeat(31)] }).success).toBe(false);
  expect(DeclarationAction.safeParse({ ...base, saisie: { libelle: "x".repeat(40) } }).success).toBe(true);
  expect(DeclarationAction.safeParse({ ...base, saisie: { libelle: "x".repeat(41) } }).success).toBe(false);
  expect(DeclarationAction.safeParse({ ...base, dureeMaxMinutes: 60 }).success).toBe(true);
  expect(DeclarationAction.safeParse({ ...base, dureeMaxMinutes: 61 }).success).toBe(false);
  expect(DeclarationAction.safeParse({ ...base, miseEnPage: "x".repeat(1001) }).success).toBe(false);
});

test("ID_ACTION", () => {
  expect(ID_ACTION.test("gitlab-mr")).toBe(true);
  expect(ID_ACTION.test("Gitlab")).toBe(false);
  expect(ID_ACTION.test(".cache")).toBe(false);
  expect(ID_ACTION.test("a".repeat(61))).toBe(false);
});
