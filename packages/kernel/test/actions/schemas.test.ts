import { expect, test } from "vitest";
import { DeclarationAction, ID_ACTION, WEB_WITH_ACCOUNT } from "../../src/index.js";

const message = (raw: unknown) => {
  const r = DeclarationAction.safeParse(raw);
  return r.success ? null : r.error.issues.map((i) => i.message).join(" | ");
};

test("the GitLab example (gitlab.com account, keywords, miseEnPage) is accepted", () => {
  const d = DeclarationAction.parse({
    name: "Mes merge requests",
    description: "Les merge requests qui m'attendent",
    keywords: ["gitlab", "mr", "revue"],
    sources: { account: ["gitlab.com"] },
    layout: "Un tableau par projet, les plus anciennes d'abord",
  });
  expect(d.sources).toEqual({ account: ["gitlab.com"], public: [], web: false });
  expect(d.input).toBeUndefined();
});

test("the Leboncoin example (web, input « Recherche ») is accepted", () => {
  const d = DeclarationAction.parse({ name: "Leboncoin", sources: { web: true }, input: { label: "Recherche" }, maxDurationMinutes: 10 });
  expect(d.input).toEqual({ label: "Recherche" });
  expect(d.description).toBe("");
  expect(d.keywords).toEqual([]);
});

test("web with an account: WEB_WITH_ACCOUNT", () => {
  expect(message({ name: "X", sources: { web: true, account: ["gitlab.com"] } })).toBe(WEB_WITH_ACCOUNT);
});

test("unknown key (recolte, tailles) refused", () => {
  expect(message({ name: "X", sources: {}, harvest: { minutes: 30 } })).not.toBeNull();
  expect(message({ name: "X", sources: {}, sizes: {} })).not.toBeNull();
  expect(message({ name: "X", sources: {}, input: { label: "R", default: "x" } })).not.toBeNull();
});

test("11 keywords, 41-character label, maxDurationMinutes 61 refused", () => {
  const base = { name: "X", sources: {} };
  expect(DeclarationAction.safeParse({ ...base, keywords: Array.from({ length: 10 }, (_, i) => `m${i}`) }).success).toBe(true);
  expect(DeclarationAction.safeParse({ ...base, keywords: Array.from({ length: 11 }, (_, i) => `m${i}`) }).success).toBe(false);
  expect(DeclarationAction.safeParse({ ...base, keywords: ["x".repeat(31)] }).success).toBe(false);
  expect(DeclarationAction.safeParse({ ...base, input: { label: "x".repeat(40) } }).success).toBe(true);
  expect(DeclarationAction.safeParse({ ...base, input: { label: "x".repeat(41) } }).success).toBe(false);
  expect(DeclarationAction.safeParse({ ...base, maxDurationMinutes: 60 }).success).toBe(true);
  expect(DeclarationAction.safeParse({ ...base, maxDurationMinutes: 61 }).success).toBe(false);
  expect(DeclarationAction.safeParse({ ...base, layout: "x".repeat(1001) }).success).toBe(false);
});

test("ID_ACTION", () => {
  expect(ID_ACTION.test("gitlab-mr")).toBe(true);
  expect(ID_ACTION.test("Gitlab")).toBe(false);
  expect(ID_ACTION.test(".cache")).toBe(false);
  expect(ID_ACTION.test("a".repeat(61))).toBe(false);
});
