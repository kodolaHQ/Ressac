import { expect, test } from "vitest";
import type { BlocLu, EtatBloc } from "../../src/accueil/schemas.js";
import { blocsAEchoir, consigneVeille } from "../../src/veille/echeances.js";

const maintenant = new Date("2026-10-26T08:00:00.000Z");
const ilYa = (h: number) => new Date(maintenant.getTime() - h * 3_600_000).toISOString();
function bloc(id: string, etat: Partial<EtatBloc>, heures?: number): BlocLu {
  return {
    id,
    dossier: `/x/${id}`,
    cheminHtml: null,
    config: { titre: id, type: "agent", consigne: "c", ...(heures ? { rafraichissement: { heures } } : {}) },
    etat: { derniereMaj: null, derniereTentative: null, statut: "ok", ...etat },
  };
}

test("au lancement : 12 h écoulées → à échoir ; 11 h → non", () => {
  const blocs = [bloc("douze", { derniereMaj: ilYa(12) }), bloc("onze", { derniereMaj: ilYa(11) })];
  expect(blocsAEchoir(blocs, maintenant, { auLancement: true })).toEqual(["douze"]);
});

test("en cours de route : 24 h ; un bloc avec heures: 6 → 6 h", () => {
  const blocs = [
    bloc("vingt", { derniereMaj: ilYa(20) }),
    bloc("vingt-quatre", { derniereMaj: ilYa(24) }),
    bloc("six", { derniereMaj: ilYa(6) }, 6),
    bloc("cinq", { derniereMaj: ilYa(5) }, 6),
  ];
  expect(blocsAEchoir(blocs, maintenant, { auLancement: false })).toEqual(["vingt-quatre", "six"]);
});

test("au lancement, un bloc de période 6 h suit son propre seuil", () => {
  expect(blocsAEchoir([bloc("six", { derniereMaj: ilYa(7) }, 6)], maintenant, { auLancement: true })).toEqual(["six"]);
});

test("jamais mis à jour → à échoir", () => {
  expect(blocsAEchoir([bloc("neuf", {})], maintenant, { auLancement: false })).toEqual(["neuf"]);
});

test("erreur : réessai seulement après 1 h", () => {
  const e = (h: number) => bloc(`e${h}`, { statut: "erreur", derniereMaj: ilYa(1), derniereTentative: ilYa(h) });
  expect(blocsAEchoir([e(59 / 60), e(1)], maintenant, { auLancement: false })).toEqual(["e1"]);
});

test("en-cours : ignoré sauf au lancement", () => {
  const b = bloc("c", { statut: "en-cours", derniereMaj: ilYa(1), derniereTentative: ilYa(0.1) });
  expect(blocsAEchoir([b], maintenant, { auLancement: false })).toEqual([]);
  expect(blocsAEchoir([b], maintenant, { auLancement: true })).toEqual(["c"]);
});

test("les blocs app et les blocs invalides sont ignorés", () => {
  const app: BlocLu = { ...bloc("app", {}), config: { titre: "a", type: "app", url: "https://a.test" } } as BlocLu;
  const casse: BlocLu = { id: "casse", dossier: "/x/casse", erreur: "bloc.json invalide" };
  expect(blocsAEchoir([app, casse], maintenant, { auLancement: true })).toEqual([]);
});

test("consigneVeille : texte exact", () => {
  expect(consigneVeille("veille-svelte", { titre: "Veille Svelte", type: "agent", consigne: "Résume Svelte." })).toBe(
    "Tu mets à jour le bloc « Veille Svelte » de la page d'accueil WebAiOs.\n" +
      "Consigne : Résume Svelte.\n" +
      "Écris le résultat complet dans /workspace/accueil/blocs/veille-svelte/index.html en suivant le format décrit dans /workspace/AGENTS.md. Ne modifie aucun autre fichier.",
  );
});
