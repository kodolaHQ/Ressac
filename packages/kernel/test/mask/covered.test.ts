import { expect, test } from "vitest";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { CoveredConversations } from "../../src/mask/covered.js";
import { Masker } from "../../src/mask/masker.js";
import { tempFolder } from "../helpers/temp.js";

/** The window's banner says « non couverte ». */
const uncovered = (m: Pick<Masker, "uncoveredCause">, win: string) => {
  const c = m.uncoveredCause(win);
  return c.resumed || c.passport.length > 0;
};

const A = "11111111-2222-3333-4444-555555555555";
const B = "66666666-7777-8888-9999-000000000000";

test("an added conversation is covered, for a new instance on the same file too; an unknown one is not", async () => {
  const file = join(await tempFolder(), "masking", "covered.json");
  const a = new CoveredConversations(file);
  expect(a.has(A)).toBe(false);
  await Promise.all([a.add(A), a.add(B), a.add(A)]);
  expect(new CoveredConversations(file).has(A)).toBe(true);
  expect(new CoveredConversations(file).has(B)).toBe(true);
  expect(a.has("autre")).toBe(false);
});

test("an unreadable or invalid file covers nothing (the banner shows), and the next add starts it again", async () => {
  const folder = join(await tempFolder(), "masking");
  await mkdir(folder, { recursive: true });
  const file = join(folder, "covered.json");
  await writeFile(file, "{ pas du json");
  const c = new CoveredConversations(file);
  expect(c.has(A)).toBe(false);
  await c.add(B);
  expect(c.has(B)).toBe(true);
  await writeFile(file, JSON.stringify({ ids: [A] }));
  expect(c.has(A)).toBe(false);
});

test("the masker tells an uncovered window's session, and forgets it when the session closes", () => {
  const masker = new Masker();
  masker.open("s1", "f1", { uncovered: true });
  masker.open("s2", "f2");
  expect(uncovered(masker, "f1")).toBe(true);
  expect(uncovered(masker, "f2")).toBe(false);
  expect(uncovered(masker, "f3")).toBe(false);
  masker.close("s1");
  expect(uncovered(masker, "f1")).toBe(false);
});

test("a removed conversation is no longer covered; the others stay", async () => {
  const c = new CoveredConversations(join(await tempFolder(), "masking", "covered.json"));
  await Promise.all([c.add(A), c.add(B)]);
  await c.remove(A);
  expect(c.has(A)).toBe(false);
  expect(c.has(B)).toBe(true);
});
