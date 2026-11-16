import { expect, test } from "vitest";
import { writeFile, mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { spacePaths } from "../../src/paths.js";
import { watchHome, watchActions } from "../../src/home/watch.js";
import { tempFolder } from "../helpers/temp.js";

test("watchHome calls the callback only once for a burst of writes", async () => {
  const c = spacePaths(await tempFolder());
  await mkdir(join(c.widgets, "x"), { recursive: true });
  let calls = 0;
  const stop = watchHome(c, () => calls++);
  await sleep(300); // laisse chokidar s'initialiser
  for (let i = 0; i < 5; i++) {
    await writeFile(join(c.widgets, "x", "display.html"), `<p>${i}</p>`);
    await sleep(4);
  }
  await sleep(500);
  await stop();
  expect(calls).toBe(1);
});

test("watchActions follows ~/Ressac/actions and components, once per burst", async () => {
  const c = spacePaths(await tempFolder());
  let calls = 0;
  const stop = watchActions(c, () => calls++);
  await sleep(300);
  await mkdir(join(c.actions, "gitlab"), { recursive: true });
  await writeFile(join(c.actions, "gitlab", "action.json"), "{}");
  await sleep(500);
  expect(calls).toBe(1);
  await mkdir(join(c.components, "barres"), { recursive: true });
  await writeFile(join(c.components, "barres", "component.html"), "<svg/>");
  await sleep(500);
  await stop();
  expect(calls).toBe(2);
});

test("watchHome does not follow a link the agent puts in home/", async () => {
  const c = spacePaths(await tempFolder());
  const outside = await tempFolder();
  await mkdir(c.home, { recursive: true });
  await symlink(outside, join(c.home, "x"));
  await sleep(300); // the link's own creation event must not reach the watcher
  let calls = 0;
  const stop = watchHome(c, () => calls++);
  await sleep(300);
  await writeFile(join(outside, "file.txt"), "changed");
  await sleep(500);
  await stop();
  expect(calls).toBe(0);
});
