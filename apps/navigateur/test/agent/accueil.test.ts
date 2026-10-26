import { expect, test } from "vitest";
import type { EtatAccueil } from "@webaios/noyau";
import { avecBase, cheminBloc, versBlocsAffiches } from "../../src/main/agent/accueil";

const etat: EtatAccueil = {
  ordre: ["app", "veille", "vide", "casse"],
  blocs: [
    { id: "veille", dossier: "/b/veille", config: { titre: "Veille", type: "agent", consigne: "c" }, etat: { derniereMaj: "2026-10-26T08:00:00.000Z", derniereTentative: null, statut: "erreur", erreur: "délai" }, cheminHtml: "/b/veille/index.html" },
    { id: "app", dossier: "/b/app", config: { titre: "daily.dev", type: "app", url: "https://app.daily.dev" }, etat: { derniereMaj: null, derniereTentative: null, statut: "ok" }, cheminHtml: null },
    { id: "vide", dossier: "/b/vide", config: { titre: "Vide", type: "agent", consigne: "c" }, etat: { derniereMaj: null, derniereTentative: null, statut: "en-cours" }, cheminHtml: null },
    { id: "casse", dossier: "/b/casse", erreur: "bloc.json invalide : x" },
  ],
};

test("versBlocsAffiches : ordre de disposition, src versionnée, statuts, bloc illisible", () => {
  expect(versBlocsAffiches(etat, { veille: 42 })).toEqual([
    { id: "app", titre: "daily.dev", type: "app", url: "https://app.daily.dev" },
    { id: "veille", titre: "Veille", type: "agent", src: "webaios-bloc://veille/index.html?v=42", statut: "erreur", derniereMaj: "2026-10-26T08:00:00.000Z", derniereTentative: null, erreur: "délai" },
    { id: "vide", titre: "Vide", type: "agent", src: null, statut: "en-cours", derniereMaj: null, derniereTentative: null },
    { id: "casse", erreur: "bloc.json invalide : x" },
  ]);
});

test("cheminBloc : seulement <blocs>/<id>/index.html, id en kebab-case", () => {
  expect(cheminBloc("/b", "webaios-bloc://veille/index.html?v=1")).toBe("/b/veille/index.html");
  expect(cheminBloc("/b", "webaios-bloc://../index.html")).toBeNull();
  expect(cheminBloc("/b", "webaios-bloc://veille/bloc.json")).toBeNull();
  expect(cheminBloc("/b", "webaios-bloc://Veille_X/index.html")).toBeNull();
  expect(cheminBloc("/b", "webaios-bloc://veille/../../etc/index.html")).toBeNull();
  expect(cheminBloc("/b", "https://veille/index.html")).toBeNull();
});

test("avecBase : les liens du bloc visent une nouvelle fenêtre, sans casser le doctype", () => {
  expect(avecBase('<html><head lang="fr"><title>x</title></head></html>')).toBe('<html><head lang="fr"><base target="_blank"><title>x</title></head></html>');
  expect(avecBase("<!doctype html><p>a</p>")).toBe('<!doctype html><base target="_blank"><p>a</p>');
  expect(avecBase("<p>a</p>")).toBe('<base target="_blank"><p>a</p>');
});
