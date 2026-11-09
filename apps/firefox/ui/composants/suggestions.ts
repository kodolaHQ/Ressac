import type { ActionAffichee } from "../../shared/actions";

export const SUGGESTIONS_MAX = 5;

export type Suggestion = { id: string; nom: string; saisie: string | null };

/** Without accents or case, spaces tightened. */
export function normaliser(t: string): string {
  return t.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** The whole name, its words and the keywords, normalized. */
function termes(a: ActionAffichee): string[] {
  const nom = normaliser(a.nom);
  return [...new Set([nom, ...nom.split(/[^\p{L}\p{N}]+/u).filter(Boolean), ...a.motsCles.map(normaliser).filter(Boolean)])];
}

/** The rest of the typed text (as is, trimmed) after the normalized term `terme` and a space; null if the text does not start that way. */
function resteApres(texte: string, terme: string): string | null {
  for (let i = 1; i < texte.length; i++) {
    if (!/\s/.test(texte[i]!)) continue;
    if (normaliser(texte.slice(0, i)) === terme) return texte.slice(i).trim();
  }
  return null;
}

/** The actions matching the new tab's text: by name or keyword, or, with an input, « terme reste-de-la-saisie ». */
export function suggestionsActions(texte: string, actions: ActionAffichee[]): Suggestion[] {
  const q = normaliser(texte);
  if (!q) return [];
  const brut = texte.trim();
  const trouvees: { s: Suggestion; exact: boolean; ordre: string }[] = [];
  for (const a of actions) {
    if (a.erreur) continue;
    const t = termes(a);
    const ordre = normaliser(a.nom);
    if (t.some((x) => x.startsWith(q))) {
      trouvees.push({ s: { id: a.id, nom: a.nom, saisie: null }, exact: t.includes(q), ordre });
      continue;
    }
    if (!a.saisie) continue;
    // The longest term first: « mes tickets » before « mes ».
    for (const terme of [...t].sort((x, y) => y.length - x.length)) {
      if (!q.startsWith(`${terme} `)) continue;
      const reste = resteApres(brut, terme);
      if (reste === null) continue;
      trouvees.push({ s: { id: a.id, nom: a.nom, saisie: reste || null }, exact: true, ordre });
      break;
    }
  }
  trouvees.sort((x, y) => Number(y.exact) - Number(x.exact) || x.ordre.localeCompare(y.ordre));
  return trouvees.slice(0, SUGGESTIONS_MAX).map((t) => t.s);
}
