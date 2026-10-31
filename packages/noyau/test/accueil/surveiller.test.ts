import { expect, test } from "vitest";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as attendre } from "node:timers/promises";
import { cheminsEspace } from "../../src/chemins.js";
import { surveillerAccueil, surveillerActions } from "../../src/accueil/surveiller.js";
import { dossierTemporaire } from "../aide/temporaire.js";

test("surveillerAccueil appelle le rappel une seule fois pour une rafale d'écritures", async () => {
  const c = cheminsEspace(await dossierTemporaire());
  await mkdir(join(c.widgets, "x"), { recursive: true });
  let appels = 0;
  const arreter = surveillerAccueil(c, () => appels++);
  await attendre(300); // laisse chokidar s'initialiser
  for (let i = 0; i < 5; i++) {
    await writeFile(join(c.widgets, "x", "affichage.html"), `<p>${i}</p>`);
    await attendre(4);
  }
  await attendre(500);
  await arreter();
  expect(appels).toBe(1);
});

test("surveillerActions suit ~/WebAiOs/actions et composants, une fois par rafale", async () => {
  const c = cheminsEspace(await dossierTemporaire());
  let appels = 0;
  const arreter = surveillerActions(c, () => appels++);
  await attendre(300);
  await mkdir(join(c.actions, "gitlab"), { recursive: true });
  await writeFile(join(c.actions, "gitlab", "action.json"), "{}");
  await attendre(500);
  expect(appels).toBe(1);
  await mkdir(join(c.composants, "barres"), { recursive: true });
  await writeFile(join(c.composants, "barres", "composant.html"), "<svg/>");
  await attendre(500);
  await arreter();
  expect(appels).toBe(2);
});
