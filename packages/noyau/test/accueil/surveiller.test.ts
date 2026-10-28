import { expect, test } from "vitest";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as attendre } from "node:timers/promises";
import { cheminsEspace } from "../../src/chemins.js";
import { surveillerAccueil } from "../../src/accueil/surveiller.js";
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
