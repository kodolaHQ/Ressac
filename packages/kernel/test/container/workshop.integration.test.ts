import { afterAll, expect, test } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { spacePaths } from "../../src/paths.js";
import { Workshop, CONTAINER_NAME } from "../../src/container/workshop.js";
import { defaultRunner } from "../../src/container/runner.js";
import { tempFolder } from "../helpers/temp.js";
import { engineCli, realEngine } from "../helpers/real-engine.js";

// Launched by hand: ATELIER_INTEGRATION=1. Uses the real Docker/OrbStack and builds the image, or the real machine with
// RESSAC_REAL_ENGINE=machine (then TMPDIR must be inside its mounted root).
// The container bears the real name: the test refuses to run if a workshop already exists, and deletes it at the end.
const active = process.env.ATELIER_INTEGRATION === "1";
const engine = active ? realEngine() : null;

test.skipIf(!active)("the real container starts, runs claude and shares /workspace", async () => {
  const c = spacePaths(await tempFolder());
  const workshop = new Workshop({ paths: c, engine: () => engine! });
  expect(await workshop.state(), "un atelier existe déjà : test annulé").toBe("absent");
  expect(await workshop.ensureStarted()).toBe("started");
  const [cmd, ...args] = workshop.execCommand(["claude", "--version"], { interactive: false });
  expect((await defaultRunner(cmd!, args)).code).toBe(0);
  const [cmd2, ...args2] = workshop.execCommand(["sh", "-c", "echo ok > /workspace/sonde"], { interactive: false });
  expect((await defaultRunner(cmd2!, args2)).code).toBe(0);
  expect(existsSync(join(c.root, "sonde"))).toBe(true);
  // A second start does not recreate an up-to-date container (same root, same Dockerfile).
  const id = async () => (await defaultRunner(...engineCli(engine!, ["inspect", "-f", "{{.Id}}", CONTAINER_NAME]))).stdout.trim();
  const before = await id();
  expect(await workshop.ensureStarted()).toBe("started");
  expect(await id()).toBe(before);
  // The same container seen from another root is recreated.
  const other = new Workshop({ paths: spacePaths(await tempFolder()), engine: () => engine! });
  expect(await other.ensureStarted()).toBe("started");
  expect(await id()).not.toBe(before);
}, 600_000);

afterAll(async () => {
  if (active) await defaultRunner(...engineCli(engine!, ["rm", "-f", CONTAINER_NAME]));
}, 60_000); // Podman's rm -f waits out the 10 s stop timeout
