import { expect, test } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cheminsEspace } from "../../src/chemins.js";
import { lireTheme } from "../../src/accueil/theme.js";
import { dossierTemporaire } from "../aide/temporaire.js";

test("lireTheme returns theme null without a file", async () => {
  const c = cheminsEspace(await dossierTemporaire());
  expect(await lireTheme(c)).toEqual({ theme: null });
});

test("a valid theme is returned as is", async () => {
  const c = cheminsEspace(await dossierTemporaire());
  await mkdir(c.accueil, { recursive: true });
  await writeFile(join(c.accueil, "theme.json"), '{"version":1,"fond":"#101014","rayon":6,"police":"serif"}');
  expect(await lireTheme(c)).toEqual({ theme: { version: 1, fond: "#101014", rayon: 6, police: "serif" } });
});

test("a non-hexadecimal color, a radius of 25 or an unknown font: theme null and the error", async () => {
  const c = cheminsEspace(await dossierTemporaire());
  await mkdir(c.accueil, { recursive: true });
  for (const invalide of ['{"version":1,"fond":"rouge"}', '{"version":1,"rayon":25}', '{"version":1,"police":"comic"}']) {
    await writeFile(join(c.accueil, "theme.json"), invalide);
    const { theme, erreur } = await lireTheme(c);
    expect(theme, invalide).toBeNull();
    expect(erreur, invalide).toContain("theme.json invalide :");
  }
});

test("an unknown key: theme null and the error", async () => {
  const c = cheminsEspace(await dossierTemporaire());
  await mkdir(c.accueil, { recursive: true });
  await writeFile(join(c.accueil, "theme.json"), '{"version":1,"inconnu":1}');
  const { theme, erreur } = await lireTheme(c);
  expect(theme).toBeNull();
  expect(erreur).toContain("theme.json invalide :");
});

test("an unreadable file leaves the file intact", async () => {
  const c = cheminsEspace(await dossierTemporaire());
  await mkdir(c.accueil, { recursive: true });
  const contenu = '{"version":1,"fond":';
  await writeFile(join(c.accueil, "theme.json"), contenu);
  const { theme, erreur } = await lireTheme(c);
  expect(theme).toBeNull();
  expect(erreur).toContain("theme.json invalide :");
  expect(await readFile(join(c.accueil, "theme.json"), "utf8")).toBe(contenu);
});
