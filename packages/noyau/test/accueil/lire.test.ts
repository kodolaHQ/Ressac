import { expect, test } from "vitest";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cheminsEspace } from "../../src/chemins.js";
import { lireAccueil } from "../../src/accueil/lire.js";
import { dossierTemporaire } from "../aide/temporaire.js";
import { declarationWidget, ecrireWidget } from "../aide/accueil.js";

async function espace() {
  const c = cheminsEspace(await dossierTemporaire());
  await mkdir(c.widgets, { recursive: true });
  const dossierWidgets = await dossierTemporaire();
  return { c, dossierWidgets };
}

test("reads the widgets and their placement from disposition.json", async () => {
  const { c, dossierWidgets } = await espace();
  await ecrireWidget(c, "a");
  await ecrireWidget(c, "b");
  const disposition = { version: 2, widgets: [{ id: "b", x: 0, y: 0, l: 3, h: 2 }, { id: "a", x: 5, y: 1, l: 4, h: 4 }, { id: "fantome", x: 0, y: 9, l: 1, h: 1 }] };
  await writeFile(c.disposition, JSON.stringify(disposition));
  const etat = await lireAccueil(c, dossierWidgets);
  expect(etat.widgets.map((w) => w.id)).toEqual(["a", "b"]);
  expect(etat.disposition).toEqual([
    { id: "b", x: 0, y: 0, l: 3, h: 2 },
    { id: "a", x: 5, y: 1, l: 4, h: 4 },
  ]);
});

test("a widget without a placement is put at the first free spot, at its default size", async () => {
  const { c, dossierWidgets } = await espace();
  await ecrireWidget(c, "a", declarationWidget({ l: 4, h: 2 }));
  await ecrireWidget(c, "b", declarationWidget({ l: 6, h: 3 }));
  await ecrireWidget(c, "c", declarationWidget({ l: 3, h: 1 }));
  await writeFile(c.disposition, JSON.stringify({ version: 2, widgets: [{ id: "a", x: 0, y: 0, l: 4, h: 2 }] }));
  const { disposition } = await lireAccueil(c, dossierWidgets);
  expect(disposition).toContainEqual({ id: "a", x: 0, y: 0, l: 4, h: 2 });
  expect(disposition).toContainEqual({ id: "b", x: 4, y: 0, l: 6, h: 3 });
  expect(disposition).toContainEqual({ id: "c", x: 0, y: 2, l: 3, h: 1 }); // 10 + 3 would overflow: next row
});

test("a placement that overlaps or overflows is moved", async () => {
  const { c, dossierWidgets } = await espace();
  await ecrireWidget(c, "a");
  await ecrireWidget(c, "b");
  await ecrireWidget(c, "c");
  await writeFile(
    c.disposition,
    JSON.stringify({ version: 2, widgets: [{ id: "a", x: 0, y: 0, l: 4, h: 4 }, { id: "b", x: 2, y: 2, l: 4, h: 4 }, { id: "c", x: 10, y: 0, l: 4, h: 4 }] }),
  );
  const { disposition } = await lireAccueil(c, dossierWidgets);
  expect(disposition).toEqual([
    { id: "a", x: 0, y: 0, l: 4, h: 4 },
    { id: "b", x: 4, y: 0, l: 4, h: 4 },
    { id: "c", x: 8, y: 0, l: 4, h: 4 },
  ]);
});

test("an invalid widget.json gives a WidgetLu in error without preventing the others", async () => {
  const { c, dossierWidgets } = await espace();
  await ecrireWidget(c, "casse", "{ pas du json");
  await ecrireWidget(c, "faux", { nom: "", tailles: {} });
  await ecrireWidget(c, "compte-sans-publiques", declarationWidget(undefined, { sources: { compte: ["x.test"], publiques: [] } }));
  await ecrireWidget(c, "ok");
  const { widgets, disposition } = await lireAccueil(c, dossierWidgets);
  const casse = widgets.find((w) => w.id === "casse")!;
  expect("erreur" in casse && casse.erreur).toContain("widget.json");
  expect("erreur" in widgets.find((w) => w.id === "faux")!).toBe(true);
  const compte = widgets.find((w) => w.id === "compte-sans-publiques")!;
  expect("declaration" in compte && compte.declaration.sources).toEqual({ compte: ["x.test"], publiques: [], web: false });
  expect("declaration" in widgets.find((w) => w.id === "ok")!).toBe(true);
  expect(disposition.map((p) => p.id).sort()).toEqual(["compte-sans-publiques", "ok"]);
});

test("a layout in the old format ({ ordre }) is ignored: everything is placed again", async () => {
  const { c, dossierWidgets } = await espace();
  await ecrireWidget(c, "b", declarationWidget({ l: 6, h: 2 }));
  await ecrireWidget(c, "a", declarationWidget({ l: 6, h: 2 }));
  await writeFile(c.disposition, JSON.stringify({ ordre: ["b", "a"] }));
  expect((await lireAccueil(c, dossierWidgets)).disposition).toEqual([
    { id: "a", x: 0, y: 0, l: 6, h: 2 },
    { id: "b", x: 6, y: 0, l: 6, h: 2 },
  ]);
  await writeFile(c.disposition, "n'importe quoi");
  expect((await lireAccueil(c, dossierWidgets)).disposition).toHaveLength(2);
});

test("the data and the state come from dossierWidgets, never from the space", async () => {
  const { c, dossierWidgets } = await espace();
  const etat = { statut: "erreur", derniereMaj: null, derniereTentative: "2026-10-28T07:00:00.000Z", erreur: "boum" };
  await ecrireWidget(c, "w", declarationWidget(), { "donnees.json": '{"piege":true}', "etat.json": JSON.stringify({ ...etat, erreur: "piège" }) });
  const w0 = (await lireAccueil(c, dossierWidgets)).widgets[0]!;
  expect("donnees" in w0 && w0.donnees).toBeNull();
  expect("etat" in w0 && w0.etat).toEqual({ statut: "ok", derniereMaj: null, derniereTentative: null });
  await mkdir(join(dossierWidgets, "w"), { recursive: true });
  await writeFile(join(dossierWidgets, "w", "donnees.json"), '{"n":1}');
  await writeFile(join(dossierWidgets, "w", "etat.json"), JSON.stringify(etat));
  const w1 = (await lireAccueil(c, dossierWidgets)).widgets[0]!;
  expect("donnees" in w1 && w1.donnees).toEqual({ n: 1 });
  expect("etat" in w1 && w1.etat).toEqual(etat);
});

test("exemple.json is read; aRecolte and aAffichage reflect the files present", async () => {
  const { c, dossierWidgets } = await espace();
  await ecrireWidget(c, "nu");
  await ecrireWidget(c, "complet", declarationWidget(), { "exemple.json": '{"x":1}', "recolte.mjs": "export default async () => 1", "affichage.html": "<p>a</p>" });
  const { widgets } = await lireAccueil(c, dossierWidgets);
  const nu = widgets.find((w) => w.id === "nu")!;
  const complet = widgets.find((w) => w.id === "complet")!;
  expect("declaration" in nu && [nu.exemple, nu.aRecolte, nu.aAffichage]).toEqual([null, false, false]);
  expect("declaration" in complet && [complet.exemple, complet.aRecolte, complet.aAffichage]).toEqual([{ x: 1 }, true, true]);
});

test("aRecolte true with workflow.json alone; aWorkflow says so", async () => {
  const { c, dossierWidgets } = await espace();
  await ecrireWidget(c, "flux", declarationWidget(), { "workflow.json": '{"version":1,"blocs":[]}' });
  await ecrireWidget(c, "ancien", declarationWidget(), { "recolte.mjs": "export default async () => 1" });
  const { widgets } = await lireAccueil(c, dossierWidgets);
  const flux = widgets.find((w) => w.id === "flux")!;
  const ancien = widgets.find((w) => w.id === "ancien")!;
  expect("declaration" in flux && [flux.aRecolte, flux.aWorkflow]).toEqual([true, true]);
  expect("declaration" in ancien && [ancien.aRecolte, ancien.aWorkflow]).toEqual([true, false]);
});

test("a widget.json that is a symbolic link outside the folder is refused", async () => {
  const { c, dossierWidgets } = await espace();
  const dehors = await dossierTemporaire();
  await writeFile(join(dehors, "autre.json"), JSON.stringify(declarationWidget()));
  await mkdir(join(c.widgets, "lien"), { recursive: true });
  await symlink(join(dehors, "autre.json"), join(c.widgets, "lien", "widget.json"));
  const w = (await lireAccueil(c, dossierWidgets)).widgets[0]!;
  expect("erreur" in w).toBe(true);
});

test("dossier de widgets absent → accueil vide", async () => {
  const c = cheminsEspace(await dossierTemporaire());
  expect(await lireAccueil(c, await dossierTemporaire())).toEqual({ disposition: [], widgets: [] });
});
