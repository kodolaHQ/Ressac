import { expect, test } from "vitest";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as attendre } from "node:timers/promises";
import { spacePaths } from "../../src/chemins.js";
import { watchHome, watchActions } from "../../src/accueil/surveiller.js";
import { tempFolder } from "../aide/temporaire.js";

test("surveillerAccueil calls the callback only once for a burst of writes", async () => {
  const c = spacePaths(await tempFolder());
  await mkdir(join(c.widgets, "x"), { recursive: true });
  let calls = 0;
  const stop = watchHome(c, () => calls++);
  await attendre(300); // laisse chokidar s'initialiser
  for (let i = 0; i < 5; i++) {
    await writeFile(join(c.widgets, "x", "affichage.html"), `<p>${i}</p>`);
    await attendre(4);
  }
  await attendre(500);
  await stop();
  expect(calls).toBe(1);
});

test("surveillerActions follows ~/WebAiOs/actions and components, once per burst", async () => {
  const c = spacePaths(await tempFolder());
  let calls = 0;
  const stop = watchActions(c, () => calls++);
  await attendre(300);
  await mkdir(join(c.actions, "gitlab"), { recursive: true });
  await writeFile(join(c.actions, "gitlab", "action.json"), "{}");
  await attendre(500);
  expect(calls).toBe(1);
  await mkdir(join(c.composants, "barres"), { recursive: true });
  await writeFile(join(c.composants, "barres", "composant.html"), "<svg/>");
  await attendre(500);
  await stop();
  expect(calls).toBe(2);
});
