import { say, sayAttribute } from "../i18n.js";
import type { LabelType, Zone } from "./detectors.js";

const TYPES = ["code", "iban", "carte", "tel", "email", "adresse", "nom", "id", "cle", "secu", "motdepasse", "masque", "date"] as const satisfies readonly LabelType[];
// A LabelType missing from TYPES makes this `never` unassignable: tsc fails.
const _allTypes: [Exclude<LabelType, (typeof TYPES)[number]>] extends [never] ? true : never = true;
void _allTypes;

/** How a card names a value without showing it (« votre code », « un IBAN »). */
export function valueName(type: LabelType, zone: Zone, locale: string): string {
  return say(locale, nameId(type, zone));
}

const nameId = (type: LabelType, zone: Zone) => (zone === "web" ? `kernel-mask-name-web-${type}` : `kernel-mask-name-${type}`);
export const NAME_IDS = TYPES.flatMap((t) => [nameId(t, "sources"), nameId(t, "web")]);

/**
 * What a sentence about these names agrees with, for Fluent: `agreement` (`one-m`, `one-f`, `other-m`, `other-f`: one name
 * or several, all feminine or not) and `de` (« de votre code, d'une adresse »). Names travel as plain text (the lock file
 * keeps only them), so each one's `.genre` and `.de` are found back from the name message that renders it; a name from
 * another language counts as masculine and keeps « de ».
 */
export function nameAgreement(names: readonly string[], locale: string): { agreement: string; de: string } {
  const ids = names.map((n) => NAME_IDS.find((id) => say(locale, id) === n));
  const feminine = names.length > 0 && ids.every((id) => id !== undefined && sayAttribute(locale, id, "genre") === "f");
  const de = names.map((n, i) => (ids[i] && sayAttribute(locale, ids[i], "de")) || say(locale, "kernel-mask-de", { name: n }));
  return { agreement: `${names.length > 1 ? "other" : "one"}-${feminine ? "f" : "m"}`, de: de.join(", ") };
}
