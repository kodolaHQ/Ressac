import { expect, test } from "vitest";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { cheminsEspace } from "../../src/chemins.js";
import { lireAccueil } from "../../src/accueil/lire.js";
import { dossierTemporaire } from "../aide/temporaire.js";
import { blocAgent, blocApp, ecrireBloc } from "../aide/accueil.js";

async function espace() {
  const c = cheminsEspace(await dossierTemporaire());
  await mkdir(c.blocs, { recursive: true });
  return c;
}

test("lit les blocs dans l'ordre de disposition, puis les non listés par id", async () => {
  const c = await espace();
  for (const id of ["a", "b", "c"]) await ecrireBloc(c, id, blocApp(id));
  await writeFile(c.disposition, JSON.stringify({ ordre: ["c", "zz-inexistant", "a"] }));
  const etat = await lireAccueil(c);
  expect(etat.ordre).toEqual(["c", "a", "b"]);
  expect(etat.blocs.map((b) => b.id)).toEqual(["c", "a", "b"]);
});

test("un bloc.json invalide n'empêche pas de lire les autres", async () => {
  const c = await espace();
  await ecrireBloc(c, "casse", "{ pas du json");
  await ecrireBloc(c, "ok", blocApp());
  await ecrireBloc(c, "faux-type", { titre: "x", type: "inconnu" });
  const { blocs } = await lireAccueil(c);
  const casse = blocs.find((b) => b.id === "casse")!;
  expect("erreur" in casse && casse.erreur).toContain("bloc.json");
  expect("erreur" in blocs.find((b) => b.id === "faux-type")!).toBe(true);
  expect("config" in blocs.find((b) => b.id === "ok")!).toBe(true);
});

test("bloc d'agent : cheminHtml null tant qu'index.html n'existe pas", async () => {
  const c = await espace();
  await ecrireBloc(c, "sans", blocAgent());
  await ecrireBloc(c, "avec", blocAgent(), { "index.html": "<p>ok</p>" });
  const { blocs } = await lireAccueil(c);
  const sans = blocs.find((b) => b.id === "sans")!;
  const avec = blocs.find((b) => b.id === "avec")!;
  expect("config" in sans && sans.cheminHtml).toBeNull();
  expect("config" in avec && avec.cheminHtml).toBe(join(c.blocs, "avec", "index.html"));
});

test("etat.json absent → état par défaut ; présent → lu", async () => {
  const c = await espace();
  await ecrireBloc(c, "neuf", blocAgent());
  const etat = { derniereMaj: "2026-10-25T07:00:00.000Z", derniereTentative: "2026-10-25T07:00:00.000Z", statut: "ok" };
  await ecrireBloc(c, "vieux", blocAgent(), { "etat.json": JSON.stringify(etat) });
  const { blocs } = await lireAccueil(c);
  const neuf = blocs.find((b) => b.id === "neuf")!;
  const vieux = blocs.find((b) => b.id === "vieux")!;
  expect("etat" in neuf && neuf.etat).toEqual({ derniereMaj: null, derniereTentative: null, statut: "ok" });
  expect("etat" in vieux && vieux.etat).toEqual(etat);
});

test("disposition.json absent ou invalide → ordre alphabétique", async () => {
  const c = await espace();
  for (const id of ["b", "a"]) await ecrireBloc(c, id, blocApp(id));
  expect((await lireAccueil(c)).ordre).toEqual(["a", "b"]);
  await writeFile(c.disposition, "n'importe quoi");
  expect((await lireAccueil(c)).ordre).toEqual(["a", "b"]);
});

test("dossier de blocs absent → accueil vide", async () => {
  const c = cheminsEspace(await dossierTemporaire());
  expect(await lireAccueil(c)).toEqual({ ordre: [], blocs: [] });
});
