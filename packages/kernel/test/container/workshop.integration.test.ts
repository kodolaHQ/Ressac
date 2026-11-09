import { afterAll, expect, test } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { spacePaths } from "../../src/paths.js";
import { Atelier, CONTAINER_NAME } from "../../src/container/workshop.js";
import { defaultRunner } from "../../src/container/runner.js";
import { tempFolder } from "../helpers/temp.js";

// Launched by hand: ATELIER_INTEGRATION=1. Uses the real Docker/OrbStack and builds the image.
// The container bears the real name: the test refuses to run if a workshop already exists, and deletes it at the end.
const active = process.env.ATELIER_INTEGRATION === "1";

test.skipIf(!active)("the real container starts, runs claude and shares /workspace", async () => {
  const c = spacePaths(await tempFolder());
  const atelier = new Atelier({ chemins: c });
  expect(await atelier.etat(), "un atelier existe déjà : test annulé").toBe("absent");
  expect(await atelier.assurerDemarre()).toBe("demarre");
  const [cmd, ...args] = atelier.commandeExec(["claude", "--version"], { interactif: false });
  expect((await defaultRunner(cmd!, args)).code).toBe(0);
  const [cmd2, ...args2] = atelier.commandeExec(["sh", "-c", "echo ok > /workspace/sonde"], { interactif: false });
  expect((await defaultRunner(cmd2!, args2)).code).toBe(0);
  expect(existsSync(join(c.racine, "sonde"))).toBe(true);
  // A second start does not recreate an up-to-date container (same root, same Dockerfile).
  const id = async () => (await defaultRunner("docker", ["inspect", "-f", "{{.Id}}", CONTAINER_NAME])).stdout.trim();
  const before = await id();
  expect(await atelier.assurerDemarre()).toBe("demarre");
  expect(await id()).toBe(before);
  // The same container seen from another root is recreated.
  const other = new Atelier({ chemins: spacePaths(await tempFolder()) });
  expect(await other.assurerDemarre()).toBe("demarre");
  expect(await id()).not.toBe(before);
}, 600_000);

afterAll(async () => {
  if (active) await defaultRunner("docker", ["rm", "-f", CONTAINER_NAME]);
});
