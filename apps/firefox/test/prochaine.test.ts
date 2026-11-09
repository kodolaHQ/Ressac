import { expect, test } from "vitest";
import { prochaineExecution } from "../ui/composants/prochaine";

// Horloges fixes, heure locale (comme les heures déclarées).
const a = (h: number, m = 0) => new Date(2026, 9, 29, h, m, 0, 0);

test("à 06:00 avec 07:00 : aujourd'hui 07:00", () => {
  expect(prochaineExecution(["07:00"], a(6))).toBe("aujourd'hui 07:00");
});

test("à 08:00 avec 07:00 : demain 07:00", () => {
  expect(prochaineExecution(["07:00"], a(8))).toBe("demain 07:00");
});

test("sans heures : null", () => {
  expect(prochaineExecution([], a(8))).toBeNull();
});

test("la plus proche des heures à venir, quel que soit leur ordre ; l'heure en cours est passée", () => {
  expect(prochaineExecution(["19:00", "07:00", "12:30"], a(8))).toBe("aujourd'hui 12:30");
  expect(prochaineExecution(["19:00", "07:00"], a(19, 0))).toBe("demain 07:00");
  expect(prochaineExecution(["19:00", "07:00"], a(18, 59))).toBe("aujourd'hui 19:00");
  expect(prochaineExecution(["00:00"], a(23, 59))).toBe("demain 00:00");
});

test("minutes et heures : la plus proche des deux (derniereMaj + minutes, ou la prochaine heure)", () => {
  const maj = (h: number, m = 0) => a(h, m).toISOString();
  // Fréquence plus proche que l'heure.
  expect(prochaineExecution(["19:00"], a(8), { minutes: 120, derniereMaj: maj(7, 30) })).toBe("aujourd'hui 09:30");
  // Heure plus proche que la fréquence.
  expect(prochaineExecution(["09:00"], a(8), { minutes: 120, derniereMaj: maj(7, 30) })).toBe("aujourd'hui 09:00");
  // Fréquence demain, plus proche que l'heure de demain.
  expect(prochaineExecution(["07:00"], a(23), { minutes: 90, derniereMaj: maj(23) })).toBe("demain 00:30");
  // Fréquence déjà dépassée, ou jamais récolté : tout de suite.
  expect(prochaineExecution(["19:00"], a(8, 15), { minutes: 60, derniereMaj: maj(6) })).toBe("aujourd'hui 08:15");
  expect(prochaineExecution(["19:00"], a(8, 15), { minutes: 60, derniereMaj: null })).toBe("aujourd'hui 08:15");
  // Sans heures : rien, comme avant (la fréquence seule n'est pas affichée).
  expect(prochaineExecution([], a(8), { minutes: 60, derniereMaj: maj(7) })).toBeNull();
});

// Règles du planificateur (packages/noyau/src/widgets/heures.ts et planificateur.ts) : un échec est réessayé 15 min
// après la dernière tentative (ou la fin de l'échec), jamais « maintenant ».
const iso = (h: number, m = 0) => a(h, m).toISOString();
const enErreur = (derniereTentative: string | null, heures?: { faite: string | null; echecs: { heure: string; nombre: number; fin?: string } | null }) => ({
  statut: "erreur" as const,
  derniereTentative,
  ...(heures ? { heures } : {}),
});

test("fréquence en erreur : 15 min après la dernière tentative, pas maintenant", () => {
  // Données vieilles (dues depuis longtemps), échec à 08:10 : prochaine à 08:25.
  expect(prochaineExecution(["19:00"], a(8, 15), { minutes: 60, derniereMaj: iso(6) }, enErreur(iso(8, 10)))).toBe("aujourd'hui 08:25");
  // Jamais récolté, échec à 08:10 : pareil.
  expect(prochaineExecution(["19:00"], a(8, 15), { minutes: 60, derniereMaj: null }, enErreur(iso(8, 10)))).toBe("aujourd'hui 08:25");
  // La fréquence plus loin que les 15 min : la fréquence.
  expect(prochaineExecution(["19:00"], a(8, 15), { minutes: 60, derniereMaj: iso(8) }, enErreur(iso(8, 5)))).toBe("aujourd'hui 09:00");
  // Les 15 min déjà passées : tout de suite.
  expect(prochaineExecution(["19:00"], a(8, 30), { minutes: 60, derniereMaj: iso(6) }, enErreur(iso(8, 10)))).toBe("aujourd'hui 08:30");
  // Statut ok : la tentative ne compte pas (comme le planificateur).
  expect(prochaineExecution(["19:00"], a(8, 15), { minutes: 60, derniereMaj: iso(6) }, { statut: "ok", derniereTentative: iso(8, 10) })).toBe("aujourd'hui 08:15");
});

test("heure fixe en échec : réessai 15 min après le plus récent de la fin de l'échec et de la dernière tentative", () => {
  const echec = (nombre: number, fin?: string) => ({ faite: null, echecs: { heure: "2026-10-29T07:00", nombre, ...(fin ? { fin } : {}) } });
  // Échec du créneau de 07:00, tentative à 07:00, veille finie à 07:30 : réessai à 07:45.
  expect(prochaineExecution(["07:00", "19:00"], a(7, 35), undefined, enErreur(iso(7), echec(1, iso(7, 30))))).toBe("aujourd'hui 07:45");
  // Sans fin : depuis la dernière tentative.
  expect(prochaineExecution(["07:00", "19:00"], a(7, 5), undefined, enErreur(iso(7), echec(1)))).toBe("aujourd'hui 07:15");
  // Tentative plus récente que la fin de l'échec (interrompue ensuite) : depuis la tentative.
  expect(prochaineExecution(["07:00", "19:00"], a(8), undefined, enErreur(iso(7, 50), echec(2, iso(7, 20))))).toBe("aujourd'hui 08:05");
  // Réessai dû : tout de suite.
  expect(prochaineExecution(["07:00", "19:00"], a(8), undefined, enErreur(iso(7), echec(1, iso(7, 10))))).toBe("aujourd'hui 08:00");
  // Plus de réessai (3 déjà faits, 4 échecs) : l'heure suivante.
  expect(prochaineExecution(["07:00", "19:00"], a(8), undefined, enErreur(iso(7, 50), echec(4, iso(7, 55))))).toBe("aujourd'hui 19:00");
  // Le réessai tomberait après l'heure suivante : l'heure suivante.
  expect(prochaineExecution(["07:00", "07:30"], a(7, 20), undefined, enErreur(iso(7, 20), echec(1)))).toBe("aujourd'hui 07:30");
  // Le créneau en échec est celui d'hier : pas de réessai, l'heure suivante.
  expect(prochaineExecution(["07:00"], a(6), undefined, enErreur(iso(7), { faite: null, echecs: { heure: "2026-10-28T07:00", nombre: 1 } }))).toBe("aujourd'hui 07:00");
  // Créneau déjà fait : l'heure suivante.
  expect(prochaineExecution(["07:00", "19:00"], a(8), undefined, enErreur(iso(7), { faite: "2026-10-29T07:00", echecs: { heure: "2026-10-29T07:00", nombre: 1 } }))).toBe("aujourd'hui 19:00");
});

test("heure fixe en échec le soir : un réessai après minuit n'a pas lieu (le créneau d'hier n'est jamais rattrapé)", () => {
  const echec = { faite: null, echecs: { heure: "2026-10-29T23:50", nombre: 1 } };
  expect(prochaineExecution(["07:00", "23:50"], a(23, 55), undefined, enErreur(iso(23, 50), echec))).toBe("demain 07:00");
});

test("heures et fréquence en erreur : la plus proche des deux règles", () => {
  const echec = { faite: null, echecs: { heure: "2026-10-29T07:00", nombre: 1, fin: iso(7, 30) } };
  // Fréquence : max(06:00 + 60 min, 07:30 + 15 min) = 07:45 ; heure : réessai à 07:45 aussi.
  expect(prochaineExecution(["07:00", "19:00"], a(7, 35), { minutes: 60, derniereMaj: iso(6) }, enErreur(iso(7, 30), echec))).toBe("aujourd'hui 07:45");
});
