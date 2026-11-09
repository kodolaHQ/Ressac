import type { ActionShown } from "../../shared/actions";

export const SUGGESTIONS_MAX = 5;

export type Suggestion = { id: string; nom: string; saisie: string | null };

/** Without accents or case, spaces tightened. */
export function normalize(t: string): string {
  return t.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** The whole name, its words and the keywords, normalized. */
function terms(a: ActionShown): string[] {
  const name = normalize(a.nom);
  return [...new Set([name, ...name.split(/[^\p{L}\p{N}]+/u).filter(Boolean), ...a.motsCles.map(normalize).filter(Boolean)])];
}

/** The rest of the typed text (as is, trimmed) after the normalized term `terme` and a space; null if the text does not start that way. */
function restAfter(text: string, term: string): string | null {
  for (let i = 1; i < text.length; i++) {
    if (!/\s/.test(text[i]!)) continue;
    if (normalize(text.slice(0, i)) === term) return text.slice(i).trim();
  }
  return null;
}

/** The actions matching the new tab's text: by name or keyword, or, with an input, « terme reste-de-la-saisie ». */
export function suggestionsActions(text: string, actions: ActionShown[]): Suggestion[] {
  const q = normalize(text);
  if (!q) return [];
  const raw = text.trim();
  const found: { s: Suggestion; exact: boolean; ordre: string }[] = [];
  for (const a of actions) {
    if (a.erreur) continue;
    const t = terms(a);
    const order = normalize(a.nom);
    if (t.some((x) => x.startsWith(q))) {
      found.push({ s: { id: a.id, nom: a.nom, saisie: null }, exact: t.includes(q), ordre: order });
      continue;
    }
    if (!a.saisie) continue;
    // The longest term first: « mes tickets » before « mes ».
    for (const term of [...t].sort((x, y) => y.length - x.length)) {
      if (!q.startsWith(`${term} `)) continue;
      const rest = restAfter(raw, term);
      if (rest === null) continue;
      found.push({ s: { id: a.id, nom: a.nom, saisie: rest || null }, exact: true, ordre: order });
      break;
    }
  }
  found.sort((x, y) => Number(y.exact) - Number(x.exact) || x.ordre.localeCompare(y.ordre));
  return found.slice(0, SUGGESTIONS_MAX).map((t) => t.s);
}
