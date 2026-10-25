import { afterAll, expect, test } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { cheminsEspace } from "../../src/chemins.js";
import { Atelier, NOM_CONTENEUR } from "../../src/conteneur/atelier.js";
import { executeurParDefaut } from "../../src/conteneur/executeur.js";
import { dossierTemporaire } from "../aide/temporaire.js";

// Lancé à la main : ATELIER_INTEGRATION=1. Utilise le vrai Docker/OrbStack et construit l'image.
// Le conteneur porte le nom réel : le test refuse de tourner si un atelier existe déjà, et le supprime à la fin.
const actif = process.env.ATELIER_INTEGRATION === "1";

test.skipIf(!actif)("le vrai conteneur démarre, exécute claude et partage /workspace", async () => {
  const c = cheminsEspace(await dossierTemporaire());
  const atelier = new Atelier({ chemins: c });
  expect(await atelier.etat(), "un atelier existe déjà : test annulé").toBe("absent");
  expect(await atelier.assurerDemarre()).toBe("demarre");
  const [cmd, ...args] = atelier.commandeExec(["claude", "--version"], { interactif: false });
  expect((await executeurParDefaut(cmd!, args)).code).toBe(0);
  const [cmd2, ...args2] = atelier.commandeExec(["sh", "-c", "echo ok > /workspace/sonde"], { interactif: false });
  expect((await executeurParDefaut(cmd2!, args2)).code).toBe(0);
  expect(existsSync(join(c.racine, "sonde"))).toBe(true);
  // Un second démarrage ne recrée pas un conteneur à jour (même racine, même Dockerfile).
  const id = async () => (await executeurParDefaut("docker", ["inspect", "-f", "{{.Id}}", NOM_CONTENEUR])).stdout.trim();
  const avant = await id();
  expect(await atelier.assurerDemarre()).toBe("demarre");
  expect(await id()).toBe(avant);
  // Le même conteneur vu depuis une autre racine est recréé.
  const autre = new Atelier({ chemins: cheminsEspace(await dossierTemporaire()) });
  expect(await autre.assurerDemarre()).toBe("demarre");
  expect(await id()).not.toBe(avant);
}, 600_000);

afterAll(async () => {
  if (actif) await executeurParDefaut("docker", ["rm", "-f", NOM_CONTENEUR]);
});
