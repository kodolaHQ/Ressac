import { afterAll, expect, test } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { spacePaths } from "../../src/chemins.js";
import { Atelier, CONTAINER_NAME } from "../../src/conteneur/atelier.js";
import { defaultRunner } from "../../src/conteneur/executeur.js";
import { dossierTemporaire } from "../aide/temporaire.js";

// Launched by hand: ATELIER_INTEGRATION=1. Uses the real Docker/OrbStack and builds the image.
// The container bears the real name: the test refuses to run if a workshop already exists, and deletes it at the end.
const actif = process.env.ATELIER_INTEGRATION === "1";

test.skipIf(!actif)("the real container starts, runs claude and shares /workspace", async () => {
  const c = spacePaths(await dossierTemporaire());
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
  const avant = await id();
  expect(await atelier.assurerDemarre()).toBe("demarre");
  expect(await id()).toBe(avant);
  // The same container seen from another root is recreated.
  const autre = new Atelier({ chemins: spacePaths(await dossierTemporaire()) });
  expect(await autre.assurerDemarre()).toBe("demarre");
  expect(await id()).not.toBe(avant);
}, 600_000);

afterAll(async () => {
  if (actif) await defaultRunner("docker", ["rm", "-f", CONTAINER_NAME]);
});
