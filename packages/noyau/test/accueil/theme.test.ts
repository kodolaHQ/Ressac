import { expect, test } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cheminsEspace } from "../../src/chemins.js";
import { lireTheme } from "../../src/accueil/theme.js";
import { dossierTemporaire } from "../aide/temporaire.js";

test("lireTheme rend theme null sans fichier", async () => {
  const c = cheminsEspace(await dossierTemporaire());
  expect(await lireTheme(c)).toEqual({ theme: null });
});

test("un thème valide est rendu tel quel", async () => {
  const c = cheminsEspace(await dossierTemporaire());
  await mkdir(c.accueil, { recursive: true });
  await writeFile(join(c.accueil, "theme.json"), '{"version":1,"fond":"#101014","rayon":6,"police":"serif"}');
  expect(await lireTheme(c)).toEqual({ theme: { version: 1, fond: "#101014", rayon: 6, police: "serif" } });
});

test("une couleur non hexadécimale, un rayon de 25 ou une police inconnue : thème null et l'erreur", async () => {
  const c = cheminsEspace(await dossierTemporaire());
  await mkdir(c.accueil, { recursive: true });
  for (const invalide of ['{"version":1,"fond":"rouge"}', '{"version":1,"rayon":25}', '{"version":1,"police":"comic"}']) {
    await writeFile(join(c.accueil, "theme.json"), invalide);
    const { theme, erreur } = await lireTheme(c);
    expect(theme, invalide).toBeNull();
    expect(erreur, invalide).toContain("theme.json invalide :");
  }
});

test("un fichier illisible laisse le fichier intact", async () => {
  const c = cheminsEspace(await dossierTemporaire());
  await mkdir(c.accueil, { recursive: true });
  const contenu = '{"version":1,"fond":';
  await writeFile(join(c.accueil, "theme.json"), contenu);
  const { theme, erreur } = await lireTheme(c);
  expect(theme).toBeNull();
  expect(erreur).toContain("theme.json invalide :");
  expect(await readFile(join(c.accueil, "theme.json"), "utf8")).toBe(contenu);
});
