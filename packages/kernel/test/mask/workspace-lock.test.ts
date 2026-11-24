import { expect, test } from "vitest";
import { join } from "node:path";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { WorkspaceLock } from "../../src/mask/lock.js";
import { Masker } from "../../src/mask/masker.js";
import { tempFolder } from "../helpers/temp.js";
import { CODE } from "./values.js";

const lockFile = async () => join(await tempFolder(), "masking", "lock.json");

test("no file: unlocked; lock() writes it 0600, a new WorkspaceLock on the same file (a restart) is locked with its names", async () => {
  const file = await lockFile();
  const a = new WorkspaceLock(file);
  expect(a.locked()).toBe(false);
  expect(a.info()).toBeNull();
  await a.lock({ names: ["votre code"] });
  expect(a.locked()).toBe(true);
  expect((await stat(file)).mode & 0o777).toBe(0o600);
  const b = new WorkspaceLock(file);
  expect(b.locked()).toBe(true);
  expect(b.info()).toEqual({ since: expect.any(String), names: ["votre code"], codes: {} });
});

test("a second lock adds its names and keeps the first lock's date and code hashes", async () => {
  const file = await lockFile();
  const w = new WorkspaceLock(file);
  await w.lock({ names: ["votre code"], codes: { "widget:meteo": "h1" } });
  const since = w.info()!.since;
  await w.lock({ names: ["votre IBAN", "votre code"], codes: { "widget:meteo": "h2", "widget:autre": "h3" } });
  expect(w.info()).toEqual({ since, names: ["votre code", "votre IBAN"], codes: { "widget:meteo": "h1" } });
});

test.each([["garbage", "{pas du json"], ["wrong shape", JSON.stringify({ since: 3, names: "x" })], ["empty", ""], ["null", "null"]])("a %s file reads as locked", async (_, content) => {
  const file = await lockFile();
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, content);
  const w = new WorkspaceLock(file);
  expect(w.locked()).toBe(true);
  expect(w.info()).toEqual({ since: "", names: [], codes: {} });
});

test("an unreadable path (a folder where the file should be) reads as locked", async () => {
  const file = await lockFile();
  await mkdir(file, { recursive: true });
  expect(new WorkspaceLock(file).locked()).toBe(true);
});

test("lift() removes the lock and tells its listeners; lock() tells them too", async () => {
  const file = await lockFile();
  const w = new WorkspaceLock(file);
  let calls = 0;
  const off = w.onChange(() => calls++);
  await w.lock({ names: ["votre code"] });
  await w.lift();
  expect(w.locked()).toBe(false);
  expect(new WorkspaceLock(file).locked()).toBe(false);
  expect(calls).toBe(2);
  off();
  await w.lock({ names: ["votre code"] });
  expect(calls).toBe(2);
});

test("the file holds names, never a value", async () => {
  const file = await lockFile();
  const masker = new Masker({ locale: () => "fr" });
  masker.open("A", "W1");
  const label = masker.maskTyped("W1", `Ton code : ${CODE}`).text.match(/⟨code-[a-z0-9]{8}⟩/)![0];
  const w = new WorkspaceLock(file);
  await w.lock({ names: ["votre code"] });
  const content = await readFile(file, "utf8");
  expect(content).not.toContain(CODE);
  expect(content).not.toContain(label);
});

test("while the workspace is locked: a new conversation is born locked, the main token is gated, the lock line names the values; after a restart too", async () => {
  const file = await lockFile();
  await new WorkspaceLock(file).lock({ names: ["votre code"] });
  // A fresh Masker, as after a restart: only the file says the workspace is locked.
  const masker = new Masker({ locale: () => "fr", workspace: new WorkspaceLock(file) });
  masker.open("B", "W2");
  expect(masker.lock("B").locked()).toBe(true);
  expect(masker.lock("B").allows("https://bank.example.test")).toBe(false);
  expect(masker.locks().every((l) => l.allows("https://bank.example.test"))).toBe(false);
  expect(masker.revealedNames()).toEqual(["votre code"]);
});

test("a closed conversation's lock lives in the workspace lock: once lifted, nothing gates the main token", async () => {
  const file = await lockFile();
  const w = new WorkspaceLock(file);
  const masker = new Masker({ locale: () => "fr", workspace: w });
  masker.open("A", "W1");
  masker.lock("A").reveal("⟨code-aaaaaaaa⟩", ["https://mail.example.test"]);
  await w.lock({ names: ["votre code"] });
  masker.close("A");
  expect(masker.locks().some((l) => l.locked())).toBe(true);
  await w.lift();
  expect(masker.locks().some((l) => l.locked())).toBe(false);
});

test("while the revealing conversation lives, every token may reach the value's origin and nothing else; once it ends, nothing", async () => {
  const file = await lockFile();
  const w = new WorkspaceLock(file);
  const masker = new Masker({ locale: () => "fr", workspace: w });
  masker.open("A", "W1");
  masker.lock("A").reveal("⟨code-aaaaaaaa⟩", ["https://mail.example.test"]);
  await w.lock({ names: ["votre code"] });
  const allows = (o: string) => masker.locks().every((l) => l.allows(o));
  expect(allows("https://mail.example.test")).toBe(true);
  expect(allows("https://other.example.test")).toBe(false);
  masker.close("A");
  expect(allows("https://mail.example.test")).toBe(false);
});
