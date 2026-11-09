import { expect, test } from "vitest";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { writeData, writeWidgetState, readData, readWidgetState, changeWidgetState, deleteData } from "../../src/home/data.js";
import { writeRun, writeMemory, listerExecutions, readMemory } from "../../src/index.js";
import { tempFolder } from "../helpers/temp.js";

test("atomic write of the data and the state; default state when etat.json is missing or damaged", async () => {
  const d = await tempFolder();
  expect(await readData(d, "w")).toBeNull();
  expect(await readWidgetState(d, "w")).toEqual({ statut: "ok", derniereMaj: null, derniereTentative: null });

  await writeData(d, "w", { liste: [1, 2] });
  expect(await readData(d, "w")).toEqual({ liste: [1, 2] });
  const state = { statut: "accord-requis" as const, derniereMaj: "2026-10-28T07:00:00.000Z", derniereTentative: null, journal: "x" };
  await writeWidgetState(d, "w", state);
  expect(await readWidgetState(d, "w")).toEqual(state);
  expect((await readdir(join(d, "w"))).sort()).toEqual(["donnees.json", "etat.json"]); // no .tmp left lying around

  await writeFile(join(d, "w", "etat.json"), "{ abîmé");
  expect((await readWidgetState(d, "w")).statut).toBe("ok");
  await writeFile(join(d, "w", "etat.json"), JSON.stringify({ statut: "inconnu" }));
  expect((await readWidgetState(d, "w")).derniereMaj).toBeNull();
});

test("donnees.json is limited to 2 MB", async () => {
  const d = await tempFolder();
  const gros = { t: "x".repeat(2 * 1024 * 1024) };
  await expect(writeData(d, "w", gros)).rejects.toThrow("2 Mo");
  await mkdir(join(d, "w"), { recursive: true });
  await writeFile(join(d, "w", "donnees.json"), JSON.stringify(gros));
  expect(await readData(d, "w")).toBeNull();
});

test("supprimerDonnees also erases the runs and the memory, and keeps etat.json", async () => {
  const d = await tempFolder();
  await writeData(d, "w", { a: 1 });
  await writeWidgetState(d, "w", { statut: "ok", derniereMaj: null, derniereTentative: null });
  await writeMemory(join(d, "w"), { b: { type: "liste.nouveaux", valeur: ["x"] } });
  await writeRun(join(d, "w"), {
    version: 1, id: "2026-10-29T08-00-00-000Z", proprietaire: { type: "widget", id: "w" }, declencheur: "manuelle",
    debut: "2026-10-29T08:00:00.000Z", fin: null, statut: "reussie", blocs: [],
  });
  await deleteData(d, "w");
  expect((await readdir(join(d, "w"))).sort()).toEqual(["etat.json"]);
  expect(await readData(d, "w")).toBeNull();
  expect(await readMemory(join(d, "w"))).toEqual({});
  expect(await listerExecutions(join(d, "w"))).toEqual([]);
});

test("ecrireEtatWidget keeps the hours tracking when the written state has none, and replaces it when it has one", async () => {
  const d = await tempFolder();
  const hours = { faite: "2026-10-29T07:00", echecs: null };
  await writeWidgetState(d, "w", { statut: "ok", derniereMaj: null, derniereTentative: null, heures: hours });
  await writeWidgetState(d, "w", { statut: "en-cours", derniereMaj: null, derniereTentative: "2026-10-29T08:00:00.000Z" });
  expect((await readWidgetState(d, "w")).heures).toEqual(hours);
  await writeWidgetState(d, "w", { statut: "erreur", derniereMaj: null, derniereTentative: null, erreur: "x" });
  expect((await readWidgetState(d, "w")).heures).toEqual(hours);
  const others = { faite: "2026-10-29T07:00", echecs: { heure: "2026-10-29T12:00", nombre: 2 } };
  await writeWidgetState(d, "w", { statut: "ok", derniereMaj: null, derniereTentative: null, heures: others });
  expect((await readWidgetState(d, "w")).heures).toEqual(others);
  // Without a state file or tracking: nothing is invented.
  await writeWidgetState(d, "neuf", { statut: "ok", derniereMaj: null, derniereTentative: null });
  expect("heures" in (await readWidgetState(d, "neuf"))).toBe(false);
});

test("writes of a widget's state one after the other: a write without tracking does not lose the tracking modified at the same time", async () => {
  const d = await tempFolder();
  await writeWidgetState(d, "w", { statut: "ok", derniereMaj: null, derniereTentative: null });
  for (let i = 0; i < 20; i++) {
    const hours = { faite: `2026-10-29T07:${String(i).padStart(2, "0")}`, echecs: null };
    await Promise.all([
      writeWidgetState(d, "w", { statut: "en-cours", derniereMaj: null, derniereTentative: null }),
      changeWidgetState(d, "w", (e) => ({ ...e, heures: hours })),
      writeWidgetState(d, "w", { statut: "ok", derniereMaj: null, derniereTentative: null }),
    ]);
    expect(await readWidgetState(d, "w")).toEqual({ statut: "ok", derniereMaj: null, derniereTentative: null, heures: hours });
  }
  // null: nothing is written.
  await expect(changeWidgetState(d, "w", () => null)).resolves.toBeNull();
  expect((await readWidgetState(d, "w")).statut).toBe("ok");
});
