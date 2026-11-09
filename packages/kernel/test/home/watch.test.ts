import { expect, test } from "vitest";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { spacePaths } from "../../src/paths.js";
import { watchHome, watchActions } from "../../src/home/watch.js";
import { tempFolder } from "../helpers/temp.js";

test("surveillerAccueil calls the callback only once for a burst of writes", async () => {
  const c = spacePaths(await tempFolder());
  await mkdir(join(c.widgets, "x"), { recursive: true });
  let calls = 0;
  const stop = watchHome(c, () => calls++);
  await sleep(300); // laisse chokidar s'initialiser
  for (let i = 0; i < 5; i++) {
    await writeFile(join(c.widgets, "x", "affichage.html"), `<p>${i}</p>`);
    await sleep(4);
  }
  await sleep(500);
  await stop();
  expect(calls).toBe(1);
});

test("watchActions follows ~/WebAiOs/actions and components, once per burst", async () => {
  const c = spacePaths(await tempFolder());
  let calls = 0;
  const stop = watchActions(c, () => calls++);
  await sleep(300);
  await mkdir(join(c.actions, "gitlab"), { recursive: true });
  await writeFile(join(c.actions, "gitlab", "action.json"), "{}");
  await sleep(500);
  expect(calls).toBe(1);
  await mkdir(join(c.composants, "barres"), { recursive: true });
  await writeFile(join(c.composants, "barres", "composant.html"), "<svg/>");
  await sleep(500);
  await stop();
  expect(calls).toBe(2);
});
