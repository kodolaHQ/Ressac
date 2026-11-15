import { expect, test } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spacePaths } from "../../src/paths.js";
import { readTheme } from "../../src/home/theme.js";
import { tempFolder } from "../helpers/temp.js";

test("readTheme returns theme null without a file", async () => {
  const c = spacePaths(await tempFolder());
  expect(await readTheme(c)).toEqual({ theme: null });
});

test("a valid theme is returned as is", async () => {
  const c = spacePaths(await tempFolder());
  await mkdir(c.home, { recursive: true });
  await writeFile(join(c.home, "theme.json"), '{"version":1,"background":"#101014","radius":6,"font":"serif"}');
  expect(await readTheme(c)).toEqual({ theme: { version: 1, background: "#101014", radius: 6, font: "serif" } });
});

test("a non-hexadecimal color, a radius of 25 or an unknown font: theme null and the error", async () => {
  const c = spacePaths(await tempFolder());
  await mkdir(c.home, { recursive: true });
  for (const invalid of ['{"version":1,"background":"rouge"}', '{"version":1,"radius":25}', '{"version":1,"font":"comic"}']) {
    await writeFile(join(c.home, "theme.json"), invalid);
    const { theme, error } = await readTheme(c);
    expect(theme, invalid).toBeNull();
    expect(error, invalid).toContain("theme.json invalide :");
  }
});

test("an unknown key: theme null and the error", async () => {
  const c = spacePaths(await tempFolder());
  await mkdir(c.home, { recursive: true });
  await writeFile(join(c.home, "theme.json"), '{"version":1,"inconnu":1}');
  const { theme, error } = await readTheme(c);
  expect(theme).toBeNull();
  expect(error).toContain("theme.json invalide :");
});

test("an unreadable file leaves the file intact", async () => {
  const c = spacePaths(await tempFolder());
  await mkdir(c.home, { recursive: true });
  const content = '{"version":1,"background":';
  await writeFile(join(c.home, "theme.json"), content);
  const { theme, error } = await readTheme(c);
  expect(theme).toBeNull();
  expect(error).toContain("theme.json invalide :");
  expect(await readFile(join(c.home, "theme.json"), "utf8")).toBe(content);
});
