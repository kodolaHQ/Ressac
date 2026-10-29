import { expect, test } from "vitest";
import { prochaineExecution } from "../src/renderer/composants/prochaine";

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
