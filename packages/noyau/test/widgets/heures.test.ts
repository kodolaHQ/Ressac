import { expect, test } from "vitest";
import type { EtatWidget } from "../../src/accueil/schemas.js";
import { creneauCourant, heureDue, REESSAI_HEURE_MS, REESSAIS_HEURE_MAX, suiviApres } from "../../src/widgets/heures.js";

/** Heure locale du 29 octobre 2026 (ou du jour donné). */
const le = (h: number, m: number, jour = 29) => new Date(2026, 9, jour, h, m);
type Suivi = EtatWidget["heures"];

test("valeurs : 15 min entre deux tentatives, 3 réessais au plus", () => {
  expect(REESSAI_HEURE_MS).toBe(15 * 60_000);
  expect(REESSAIS_HEURE_MAX).toBe(3);
});

test("07:00 : pas dû à 06:59, dû à 07:00, fait après une réussite commencée à 07:00:30", () => {
  const heures = ["07:00"];
  expect(creneauCourant(heures, le(6, 59))).toBeNull();
  expect(heureDue(heures, undefined, null, le(6, 59))).toBe(false);
  expect(creneauCourant(heures, le(7, 0))).toBe("2026-10-29T07:00");
  expect(heureDue(heures, undefined, null, le(7, 0))).toBe(true);
  const debut = new Date(2026, 9, 29, 7, 0, 30);
  const suivi = suiviApres(undefined, creneauCourant(heures, debut), "reussie");
  expect(suivi).toEqual({ faite: "2026-10-29T07:00", echecs: null });
  expect(heureDue(heures, suivi, debut.toISOString(), le(7, 5))).toBe(false);
  expect(heureDue(heures, suivi, debut.toISOString(), le(23, 59))).toBe(false);
});

test("07:00 et 12:00 manquées, appli ouverte à 15 h : un seul créneau dû (12:00)", () => {
  const heures = ["12:00", "07:00"]; // l'ordre déclaré ne compte pas
  expect(creneauCourant(heures, le(15, 0))).toBe("2026-10-29T12:00");
  expect(heureDue(heures, { faite: "2026-10-28T12:00", echecs: null }, null, le(15, 0))).toBe(true);
  // Une fois 12:00 faite, 07:00 n'est jamais rattrapée ce jour-là.
  const suivi = suiviApres({ faite: "2026-10-28T12:00", echecs: null }, creneauCourant(heures, le(15, 0)), "reussie");
  for (const [h, m] of [[15, 1], [18, 0], [23, 59]] as const) expect(heureDue(heures, suivi, le(15, 0).toISOString(), le(h, m))).toBe(false);
});

test("Mac en veille de 6 h à 22 h par-dessus plusieurs heures : un seul rattrapage au réveil", () => {
  const heures = ["07:00", "09:00", "12:00", "18:00"];
  const suivi: Suivi = { faite: "2026-10-28T18:00", echecs: null };
  expect(heureDue(heures, suivi, null, le(6, 0))).toBe(false);
  // Réveil à 22 h : seul 18:00 est dû ; une fois fait, plus rien jusqu'au lendemain 07:00.
  expect(creneauCourant(heures, le(22, 0))).toBe("2026-10-29T18:00");
  const apres = suiviApres(suivi, creneauCourant(heures, le(22, 0)), "reussie");
  expect(heureDue(heures, apres, le(22, 0).toISOString(), le(22, 1))).toBe(false);
  expect(heureDue(heures, apres, le(22, 0).toISOString(), le(6, 59, 30))).toBe(false);
  expect(heureDue(heures, apres, le(22, 0).toISOString(), le(7, 0, 30))).toBe(true);
});

test("manqué la veille : rien avant 07:00 le lendemain (minuit compris)", () => {
  const heures = ["07:00", "22:00"];
  // 22:00 manquée le 29 ; à minuit et après, le 30, rien n'est dû avant 07:00.
  const suivi: Suivi = { faite: "2026-10-29T07:00", echecs: null };
  expect(heureDue(heures, suivi, null, le(23, 59))).toBe(true);
  for (const [h, m] of [[0, 0], [0, 1], [6, 59]] as const) {
    expect(creneauCourant(heures, le(h, m, 30))).toBeNull();
    expect(heureDue(heures, suivi, null, le(h, m, 30))).toBe(false);
  }
  expect(creneauCourant(heures, le(7, 0, 30))).toBe("2026-10-30T07:00");
  expect(heureDue(heures, suivi, null, le(7, 0, 30))).toBe(true);
  // La même heure, faite la veille, est due de nouveau le lendemain.
  expect(heureDue(["07:00"], { faite: "2026-10-29T07:00", echecs: null }, null, le(7, 0, 30))).toBe(true);
});

test("échec : dû de nouveau 15 min après, au plus 3 réessais, puis rien jusqu'à l'heure suivante", () => {
  const heures = ["07:00", "12:00"];
  let suivi: Suivi = { faite: "2026-10-28T12:00", echecs: null };
  let tentative = le(7, 0);
  const tentatives: string[] = [];
  // Toutes les minutes de 07:00 à 11:59 : chaque fois qu'elle est due, l'exécution échoue.
  for (let t = le(7, 0).getTime(); t < le(12, 0).getTime(); t += 60_000) {
    const maintenant = new Date(t);
    if (!heureDue(heures, suivi, tentatives.length ? tentative.toISOString() : null, maintenant)) continue;
    tentative = maintenant;
    tentatives.push(`${maintenant.getHours()}:${String(maintenant.getMinutes()).padStart(2, "0")}`);
    suivi = suiviApres(suivi, creneauCourant(heures, maintenant), "echec");
  }
  expect(tentatives).toEqual(["7:00", "7:15", "7:30", "7:45"]);
  expect(suivi).toEqual({ faite: "2026-10-28T12:00", echecs: { heure: "2026-10-29T07:00", nombre: 4 } });
  // L'heure suivante repart de zéro.
  expect(heureDue(heures, suivi, tentative.toISOString(), le(12, 0))).toBe(true);
  expect(suiviApres(suivi, "2026-10-29T12:00", "echec").echecs).toEqual({ heure: "2026-10-29T12:00", nombre: 1 });
  // Une réussite efface les échecs.
  expect(suiviApres(suivi, "2026-10-29T07:00", "reussie")).toEqual({ faite: "2026-10-29T07:00", echecs: null });
});

test("une exécution manuelle à 07:10 compte pour 07:00 ; une à 06:50 ne compte pas", () => {
  const heures = ["07:00"];
  const veille: Suivi = { faite: "2026-10-28T07:00", echecs: null };
  const tot = suiviApres(veille, creneauCourant(heures, le(6, 50)), "reussie");
  // Avant la première heure du jour : sans effet, la veille n'est pas effacée.
  expect(tot).toEqual(veille);
  expect(heureDue(heures, tot, le(6, 50).toISOString(), le(7, 0))).toBe(true);
  const manuelle = suiviApres(tot, creneauCourant(heures, le(7, 10)), "reussie");
  expect(manuelle).toEqual({ faite: "2026-10-29T07:00", echecs: null });
  expect(heureDue(heures, manuelle, le(7, 10).toISOString(), le(7, 30))).toBe(false);
});

test("suiviApres : sans-effet ne change rien ; un échec avant la première heure non plus ; rien de neuf sans suivi", () => {
  const suivi: Suivi = { faite: "2026-10-29T07:00", echecs: { heure: "2026-10-29T12:00", nombre: 2 } };
  expect(suiviApres(suivi, "2026-10-29T12:00", "sans-effet")).toEqual(suivi);
  expect(suiviApres(suivi, null, "echec")).toEqual(suivi);
  expect(suiviApres(undefined, null, "reussie")).toEqual({ faite: null, echecs: null });
  expect(suiviApres(undefined, "2026-10-29T07:00", "echec")).toEqual({ faite: null, echecs: { heure: "2026-10-29T07:00", nombre: 1 } });
});

test("échec d'une exécution longue : les 15 min comptent depuis sa fin", () => {
  const heures = ["07:00"];
  // Commencée à 07:00, en échec à 07:30.
  const suivi = suiviApres(undefined, "2026-10-29T07:00", "echec", le(7, 30).toISOString());
  expect(suivi).toEqual({ faite: null, echecs: { heure: "2026-10-29T07:00", nombre: 1, fin: le(7, 30).toISOString() } });
  expect(heureDue(heures, suivi, le(7, 0).toISOString(), le(7, 30))).toBe(false);
  expect(heureDue(heures, suivi, le(7, 0).toISOString(), le(7, 44))).toBe(false);
  expect(heureDue(heures, suivi, le(7, 0).toISOString(), le(7, 45))).toBe(true);
});

test("un créneau plus ancien que celui déjà fait n'est jamais refait (retour à l'heure d'hiver, heure ajoutée plus tôt)", () => {
  // 02:45 faite, l'horloge revient à 02:00 : le créneau 02:00 est déjà couvert.
  expect(heureDue(["02:00", "02:45"], { faite: "2026-10-25T02:45", echecs: null }, null, new Date(2026, 9, 25, 2, 10))).toBe(false);
  // 07:00 faite, 06:00 ajoutée en cours de journée.
  expect(heureDue(["06:00", "07:00"], { faite: "2026-10-29T07:00", echecs: null }, null, le(6, 30))).toBe(false);
  // Une réussite pour un créneau plus ancien garde le plus récent.
  expect(suiviApres({ faite: "2026-10-29T07:00", echecs: null }, "2026-10-29T06:00", "reussie")).toEqual({ faite: "2026-10-29T07:00", echecs: null });
});
