import { expect, test } from "vitest";
import type { EtatWidget } from "../../src/accueil/schemas.js";
import { creneauCourant, heureDue, REESSAI_HEURE_MS, REESSAIS_HEURE_MAX, suiviApres } from "../../src/widgets/heures.js";

/** Local time of October 29, 2026 (or of the given day). */
const le = (h: number, m: number, jour = 29) => new Date(2026, 9, jour, h, m);
type Suivi = EtatWidget["heures"];

test("values: 15 min between two attempts, 3 retries at most", () => {
  expect(REESSAI_HEURE_MS).toBe(15 * 60_000);
  expect(REESSAIS_HEURE_MAX).toBe(3);
});

test("07:00: not due at 06:59, due at 07:00, done after a success started at 07:00:30", () => {
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

test("07:00 and 12:00 missed, app opened at 3 pm: a single slot due (12:00)", () => {
  const heures = ["12:00", "07:00"]; // the declared order does not matter
  expect(creneauCourant(heures, le(15, 0))).toBe("2026-10-29T12:00");
  expect(heureDue(heures, { faite: "2026-10-28T12:00", echecs: null }, null, le(15, 0))).toBe(true);
  // Once 12:00 is done, 07:00 is never caught up that day.
  const suivi = suiviApres({ faite: "2026-10-28T12:00", echecs: null }, creneauCourant(heures, le(15, 0)), "reussie");
  for (const [h, m] of [[15, 1], [18, 0], [23, 59]] as const) expect(heureDue(heures, suivi, le(15, 0).toISOString(), le(h, m))).toBe(false);
});

test("Mac asleep from 6 am to 10 pm over several hours: a single catch-up on wake", () => {
  const heures = ["07:00", "09:00", "12:00", "18:00"];
  const suivi: Suivi = { faite: "2026-10-28T18:00", echecs: null };
  expect(heureDue(heures, suivi, null, le(6, 0))).toBe(false);
  // Wake at 10 pm: only 18:00 is due; once done, nothing until the next day 07:00.
  expect(creneauCourant(heures, le(22, 0))).toBe("2026-10-29T18:00");
  const apres = suiviApres(suivi, creneauCourant(heures, le(22, 0)), "reussie");
  expect(heureDue(heures, apres, le(22, 0).toISOString(), le(22, 1))).toBe(false);
  expect(heureDue(heures, apres, le(22, 0).toISOString(), le(6, 59, 30))).toBe(false);
  expect(heureDue(heures, apres, le(22, 0).toISOString(), le(7, 0, 30))).toBe(true);
});

test("missed the day before: nothing before 07:00 the next day (midnight included)", () => {
  const heures = ["07:00", "22:00"];
  // 22:00 missed on the 29th; at midnight and after, the 30th, nothing is due before 07:00.
  const suivi: Suivi = { faite: "2026-10-29T07:00", echecs: null };
  expect(heureDue(heures, suivi, null, le(23, 59))).toBe(true);
  for (const [h, m] of [[0, 0], [0, 1], [6, 59]] as const) {
    expect(creneauCourant(heures, le(h, m, 30))).toBeNull();
    expect(heureDue(heures, suivi, null, le(h, m, 30))).toBe(false);
  }
  expect(creneauCourant(heures, le(7, 0, 30))).toBe("2026-10-30T07:00");
  expect(heureDue(heures, suivi, null, le(7, 0, 30))).toBe(true);
  // The same hour, done the day before, is due again the next day.
  expect(heureDue(["07:00"], { faite: "2026-10-29T07:00", echecs: null }, null, le(7, 0, 30))).toBe(true);
});

test("failure: due again 15 min later, 3 retries at most, then nothing until the next hour", () => {
  const heures = ["07:00", "12:00"];
  let suivi: Suivi = { faite: "2026-10-28T12:00", echecs: null };
  let tentative = le(7, 0);
  const tentatives: string[] = [];
  // Every minute from 07:00 to 11:59: each time it is due, the run fails.
  for (let t = le(7, 0).getTime(); t < le(12, 0).getTime(); t += 60_000) {
    const maintenant = new Date(t);
    if (!heureDue(heures, suivi, tentatives.length ? tentative.toISOString() : null, maintenant)) continue;
    tentative = maintenant;
    tentatives.push(`${maintenant.getHours()}:${String(maintenant.getMinutes()).padStart(2, "0")}`);
    suivi = suiviApres(suivi, creneauCourant(heures, maintenant), "echec");
  }
  expect(tentatives).toEqual(["7:00", "7:15", "7:30", "7:45"]);
  expect(suivi).toEqual({ faite: "2026-10-28T12:00", echecs: { heure: "2026-10-29T07:00", nombre: 4 } });
  // The next hour starts from zero.
  expect(heureDue(heures, suivi, tentative.toISOString(), le(12, 0))).toBe(true);
  expect(suiviApres(suivi, "2026-10-29T12:00", "echec").echecs).toEqual({ heure: "2026-10-29T12:00", nombre: 1 });
  // A success erases the failures.
  expect(suiviApres(suivi, "2026-10-29T07:00", "reussie")).toEqual({ faite: "2026-10-29T07:00", echecs: null });
});

test("a manual run at 07:10 counts for 07:00; one at 06:50 does not count", () => {
  const heures = ["07:00"];
  const veille: Suivi = { faite: "2026-10-28T07:00", echecs: null };
  const tot = suiviApres(veille, creneauCourant(heures, le(6, 50)), "reussie");
  // Before the first hour of the day: no effect, the previous day is not erased.
  expect(tot).toEqual(veille);
  expect(heureDue(heures, tot, le(6, 50).toISOString(), le(7, 0))).toBe(true);
  const manuelle = suiviApres(tot, creneauCourant(heures, le(7, 10)), "reussie");
  expect(manuelle).toEqual({ faite: "2026-10-29T07:00", echecs: null });
  expect(heureDue(heures, manuelle, le(7, 10).toISOString(), le(7, 30))).toBe(false);
});

test("suiviApres: sans-effet changes nothing; a failure before the first hour neither; nothing new without tracking", () => {
  const suivi: Suivi = { faite: "2026-10-29T07:00", echecs: { heure: "2026-10-29T12:00", nombre: 2 } };
  expect(suiviApres(suivi, "2026-10-29T12:00", "sans-effet")).toEqual(suivi);
  expect(suiviApres(suivi, null, "echec")).toEqual(suivi);
  expect(suiviApres(undefined, null, "reussie")).toEqual({ faite: null, echecs: null });
  expect(suiviApres(undefined, "2026-10-29T07:00", "echec")).toEqual({ faite: null, echecs: { heure: "2026-10-29T07:00", nombre: 1 } });
});

test("failure of a long run: the 15 min count from its end", () => {
  const heures = ["07:00"];
  // Started at 07:00, failed at 07:30.
  const suivi = suiviApres(undefined, "2026-10-29T07:00", "echec", le(7, 30).toISOString());
  expect(suivi).toEqual({ faite: null, echecs: { heure: "2026-10-29T07:00", nombre: 1, fin: le(7, 30).toISOString() } });
  expect(heureDue(heures, suivi, le(7, 0).toISOString(), le(7, 30))).toBe(false);
  expect(heureDue(heures, suivi, le(7, 0).toISOString(), le(7, 44))).toBe(false);
  expect(heureDue(heures, suivi, le(7, 0).toISOString(), le(7, 45))).toBe(true);
});

test("a slot older than the one already done is never redone (back to winter time, hour added earlier)", () => {
  // 02:45 done, the clock goes back to 02:00: the 02:00 slot is already covered.
  expect(heureDue(["02:00", "02:45"], { faite: "2026-10-25T02:45", echecs: null }, null, new Date(2026, 9, 25, 2, 10))).toBe(false);
  // 07:00 done, 06:00 added during the day.
  expect(heureDue(["06:00", "07:00"], { faite: "2026-10-29T07:00", echecs: null }, null, le(6, 30))).toBe(false);
  // A success for an older slot keeps the most recent one.
  expect(suiviApres({ faite: "2026-10-29T07:00", echecs: null }, "2026-10-29T06:00", "reussie")).toEqual({ faite: "2026-10-29T07:00", echecs: null });
});

test("F4: after a failure, a more recent no-effect attempt (interrupted watch) pushes the retry back by 15 min", () => {
  const heures = ["07:00"];
  // Failure ended at 07:20; then an attempt at 07:40, interrupted (no effect on the tracking).
  const suivi: Suivi = { faite: null, echecs: { heure: "2026-10-29T07:00", nombre: 1, fin: le(7, 20).toISOString() } };
  const tentative = le(7, 40).toISOString();
  expect(heureDue(heures, suivi, tentative, le(7, 45))).toBe(false);
  expect(heureDue(heures, suivi, tentative, le(7, 55))).toBe(true);
  // And the reverse: a failure end more recent than the attempt (30 min watch) still counts.
  const long: Suivi = { faite: null, echecs: { heure: "2026-10-29T07:00", nombre: 1, fin: le(7, 30).toISOString() } };
  expect(heureDue(heures, long, le(7, 0).toISOString(), le(7, 40))).toBe(false);
  expect(heureDue(heures, long, le(7, 0).toISOString(), le(7, 45))).toBe(true);
});
