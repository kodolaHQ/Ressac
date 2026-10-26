import { execFileSync } from "node:child_process";
import { expect, test } from "vitest";
import { cheminsEspace } from "../../src/chemins.js";
import { Atelier } from "../../src/conteneur/atelier.js";
import { SessionAgent } from "../../src/pty/session.js";

// Lancé à la main : SESSION_INTEGRATION=1, avec l'atelier déjà démarré (n'y lance qu'un sleep, qu'il arrête).
// Le sh du conteneur est dash : c'est ici que se voit un script d'arrêt que le sh du Mac accepterait seul.
const actif = process.env.SESSION_INTEGRATION === "1";
const dansAtelier = (motif: string) =>
  execFileSync("docker", ["exec", "webaios-atelier", "sh", "-c", `ps -eo args | grep '[${motif[0]}]${motif.slice(1)}' || true`]).toString().trim();

test.skipIf(!actif)("arrêter une session tue dans le conteneur un agent sourd à HUP et TERM, et ce qu'il a lancé", async () => {
  const a = new Atelier({ chemins: cheminsEspace() });
  expect(await a.etat()).toBe("demarre");
  const s = SessionAgent.demarrer(a.commandeSession("integration1", ["sh", "-c", "trap '' HUP TERM; sleep 302 & wait"]), {
    cols: 80, rows: 24, arreterDistant: () => a.arreterSession("integration1"),
  });
  await expect.poll(() => dansAtelier("sleep 302"), { timeout: 10_000 }).not.toBe("");
  await s.arreter();
  expect(dansAtelier("sleep 302")).toBe("");
  expect(dansAtelier("trap '' HUP")).toBe("");
}, 30_000);
