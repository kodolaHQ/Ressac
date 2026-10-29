import { expect, test } from "vitest";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ecrireDonnees, ecrireEtatWidget, lireDonnees, lireEtatWidget, supprimerDonnees } from "../../src/accueil/donnees.js";
import { ecrireExecution, ecrireMemoire, listerExecutions, lireMemoire } from "../../src/index.js";
import { dossierTemporaire } from "../aide/temporaire.js";

test("écriture atomique des données et de l'état ; état par défaut quand etat.json manque ou est abîmé", async () => {
  const d = await dossierTemporaire();
  expect(await lireDonnees(d, "w")).toBeNull();
  expect(await lireEtatWidget(d, "w")).toEqual({ statut: "ok", derniereMaj: null, derniereTentative: null });

  await ecrireDonnees(d, "w", { liste: [1, 2] });
  expect(await lireDonnees(d, "w")).toEqual({ liste: [1, 2] });
  const etat = { statut: "accord-requis" as const, derniereMaj: "2026-10-28T07:00:00.000Z", derniereTentative: null, journal: "x" };
  await ecrireEtatWidget(d, "w", etat);
  expect(await lireEtatWidget(d, "w")).toEqual(etat);
  expect((await readdir(join(d, "w"))).sort()).toEqual(["donnees.json", "etat.json"]); // pas de .tmp qui traîne

  await writeFile(join(d, "w", "etat.json"), "{ abîmé");
  expect((await lireEtatWidget(d, "w")).statut).toBe("ok");
  await writeFile(join(d, "w", "etat.json"), JSON.stringify({ statut: "inconnu" }));
  expect((await lireEtatWidget(d, "w")).derniereMaj).toBeNull();
});

test("donnees.json est limité à 2 Mo", async () => {
  const d = await dossierTemporaire();
  const gros = { t: "x".repeat(2 * 1024 * 1024) };
  await expect(ecrireDonnees(d, "w", gros)).rejects.toThrow("2 Mo");
  await mkdir(join(d, "w"), { recursive: true });
  await writeFile(join(d, "w", "donnees.json"), JSON.stringify(gros));
  expect(await lireDonnees(d, "w")).toBeNull();
});

test("supprimerDonnees efface aussi les exécutions et la mémoire, et garde etat.json", async () => {
  const d = await dossierTemporaire();
  await ecrireDonnees(d, "w", { a: 1 });
  await ecrireEtatWidget(d, "w", { statut: "ok", derniereMaj: null, derniereTentative: null });
  await ecrireMemoire(join(d, "w"), { b: { type: "liste.nouveaux", valeur: ["x"] } });
  await ecrireExecution(join(d, "w"), {
    version: 1, id: "2026-10-29T08-00-00-000Z", proprietaire: { type: "widget", id: "w" }, declencheur: "manuelle",
    debut: "2026-10-29T08:00:00.000Z", fin: null, statut: "reussie", blocs: [],
  });
  await supprimerDonnees(d, "w");
  expect((await readdir(join(d, "w"))).sort()).toEqual(["etat.json"]);
  expect(await lireDonnees(d, "w")).toBeNull();
  expect(await lireMemoire(join(d, "w"))).toEqual({});
  expect(await listerExecutions(join(d, "w"))).toEqual([]);
});
