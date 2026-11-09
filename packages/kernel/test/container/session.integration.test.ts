import { execFileSync } from "node:child_process";
import { expect, test } from "vitest";
import { spacePaths } from "../../src/paths.js";
import { Atelier } from "../../src/container/workshop.js";
import { SessionAgent } from "../../src/pty/session.js";

// Launched by hand: SESSION_INTEGRATION=1, with the workshop already started (it only launches a sleep there, which it stops).
// The container's sh is dash: this is where a stop script that the Mac's sh would accept alone shows up.
const active = process.env.SESSION_INTEGRATION === "1";
const dansAtelier = (motif: string) =>
  execFileSync("docker", ["exec", "webaios-atelier", "sh", "-c", `ps -eo args | grep '[${motif[0]}]${motif.slice(1)}' || true`]).toString().trim();

test.skipIf(!active)("stopping a session kills in the container an agent deaf to HUP and TERM, and what it launched", async () => {
  const a = new Atelier({ chemins: spacePaths() });
  expect(await a.etat()).toBe("demarre");
  const s = SessionAgent.demarrer(a.commandeSession("integration1", ["sh", "-c", "trap '' HUP TERM; sleep 302 & wait"]), {
    cols: 80, rows: 24, arreterDistant: () => a.arreterSession("integration1"),
  });
  await expect.poll(() => dansAtelier("sleep 302"), { timeout: 10_000 }).not.toBe("");
  await s.arreter();
  expect(dansAtelier("sleep 302")).toBe("");
  expect(dansAtelier("trap '' HUP")).toBe("");
}, 30_000);

test.skipIf(!active)("stopping a session also kills the servers the agent detached from its group (nohup, setsid)", async () => {
  const a = new Atelier({ chemins: spacePaths() });
  expect(await a.etat()).toBe("demarre");
  const s = SessionAgent.demarrer(a.commandeSession("integration2", ["sh", "-c", "setsid nohup sleep 303 >/dev/null 2>&1 & sleep 304"]), {
    cols: 80, rows: 24, arreterDistant: () => a.arreterSession("integration2"),
  });
  await expect.poll(() => dansAtelier("sleep 303"), { timeout: 10_000 }).not.toBe("");
  await s.arreter();
  expect(dansAtelier("sleep 303")).toBe("");
  expect(dansAtelier("sleep 304")).toBe("");
}, 30_000);

test.skipIf(!active)("at launch, the sessions left by an abruptly killed app (without a stop) are stopped", async () => {
  const a = new Atelier({ chemins: spacePaths() });
  // Without arreterDistant: like an app that dies, only the local docker client disappears.
  const s = SessionAgent.demarrer(a.commandeSession("integration3", ["sh", "-c", "trap '' HUP TERM; setsid nohup sleep 305 >/dev/null 2>&1 & sleep 306"]), { cols: 80, rows: 24 });
  await expect.poll(() => dansAtelier("sleep 305"), { timeout: 10_000 }).not.toBe("");
  await s.arreter();
  await new Promise((r) => setTimeout(r, 500));
  expect(dansAtelier("sleep 306")).not.toBe("");
  await a.arreterSessionsOrphelines();
  expect(dansAtelier("sleep 305")).toBe("");
  expect(dansAtelier("sleep 306")).toBe("");
}, 30_000);
