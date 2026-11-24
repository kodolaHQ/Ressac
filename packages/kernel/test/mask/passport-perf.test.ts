import { expect, test } from "vitest";
import { maskText } from "../../src/mask/mask.js";
import type { PassportEntry, PassportField, PassportValue } from "../../src/mask/passport-fields.js";
import { PassportStore } from "../../src/mask/passport.js";
import { LabelTable } from "../../src/mask/table.js";

const entry = (i: number, field: PassportField, value: PassportValue): PassportEntry => ({
  id: i.toString(16).padStart(16, "0"),
  field,
  value,
  variants: [],
  origins: [],
  how: "typed",
  created: "2026-11-23T10:00:00.000Z",
  updated: "2026-11-23T10:00:00.000Z",
});

const GIVEN = ["Camille", "Julien", "Lucie", "Marc", "Odile", "Bastien", "Inès", "Gaëlle", "Hervé", "Zoé"];
const FAMILY = ["Aubrac", "Ferrand", "Durand", "Lemoine", "Chabert", "Vasseur", "Mercier", "Roussel", "Garnier", "Perrin"];
// 200 entries, the cap: names, addresses, dates and free entries, every one distinct.
const passport = Array.from({ length: 200 }, (_, i): PassportEntry => {
  const [g, f] = [GIVEN[i % 10]!, `${FAMILY[Math.floor(i / 10) % 10]}${i >= 100 ? "-Neuf" : ""}`];
  switch (i % 4) {
    case 0:
      return entry(i, "nom", { given: g, family: f });
    case 1:
      return entry(i, "adresse", { text: `${i} rue des ${f}\n69005 Lyon` });
    case 2:
      return entry(i, "naissance", { text: `19${String(50 + (i % 50)).padStart(2, "0")}-0${1 + (i % 9)}-1${i % 10}` });
    default:
      return entry(i, "libre", { text: `dossier ${f} ${i}` });
  }
});

// 1 MB of mixed French text: prose, names, addresses, dates, amounts, e-mail headers, some of them the passport's.
const LINES = [
  "Bonjour, suite à notre échange d'hier, je vous confirme le rendez-vous de jeudi à 14 h 30.",
  "De : Camille Aubrac <camille.aubrac@exemple.fr>",
  "Votre commande n° 48213 a été expédiée au 4 rue des Chabert, 69005 Lyon.",
  "Montant : 1 234,56 € — échéance le 15/04/2026.",
  "L’équipe du Marché de Noël vous attend avenue Jean-Jaurès, entrée libre.",
  "Né le 12 mars 1961 à Saint-Étienne ; dossier Mercier suivi par M. Roussel.",
  "Réunion annulée : merci de prévenir Zoé et Hervé avant vendredi.",
];
let text = "";
for (let i = 0; text.length < 1_000_000; i++) text += LINES[i % LINES.length] + "\n";

/** CPU microseconds of `maskText` over the text in the sources zone, best of a few runs. */
function cpu(store: PassportStore): number {
  let best = Infinity;
  for (let run = 0; run < 3; run++) {
    const table = new LabelTable({ passport: store });
    const t0 = process.cpuUsage();
    maskText(text, { table, zone: "sources", origin: "https://mail.example" });
    const d = process.cpuUsage(t0);
    best = Math.min(best, d.user + d.system);
  }
  return best;
}

// Design § 6.7: one index for every form, never one pass per entry. A per-entry regex fallback costs about 100 times
// the empty passport's time on this text: a 2× bound is far from it.
test("a 200-entry passport costs at most twice the CPU of an empty one on 1 MB of text", () => {
  const empty = new PassportStore();
  const full = new PassportStore();
  full.replace("p1", passport);
  expect(full.entries("p1")).toHaveLength(200);
  cpu(full); // warm-up: JIT and the cached index
  expect(cpu(full)).toBeLessThanOrEqual(2 * cpu(empty));
}, 120_000);
