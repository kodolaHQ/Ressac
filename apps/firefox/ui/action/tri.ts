/**
 * The sort of an action page's table, on a header click. Cells are already formatted texts (numbers in fr-FR:
 * « 1 200 », « 2,5 »): a number compares as a number, a text with `localeCompare("fr")`, numbers before texts, and
 * an empty cell stays last whatever the direction.
 */

/** The value of a cell written as an fr-FR number, otherwise null. */
function nombre(s: string): number | null {
  const t = s.replace(/[\s  ]/g, "").replace(",", ".").replace(/^[−–]/, "-");
  return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : null;
}

const cellule = (l: Record<string, string>, champ: string) => (Object.hasOwn(l, champ) ? (l[champ] ?? "") : "").trim();

export function trierLignes(lignes: Record<string, string>[], champ: string, sens: "asc" | "desc"): Record<string, string>[] {
  const signe = sens === "asc" ? 1 : -1;
  const cles = lignes.map((l, i) => {
    const t = cellule(l, champ);
    return { l, i, t, n: nombre(t) };
  });
  cles.sort((a, b) => {
    if (!a.t || !b.t) return a.t ? -1 : b.t ? 1 : a.i - b.i;
    let c: number;
    if (a.n !== null && b.n !== null) c = a.n - b.n;
    else if (a.n !== null || b.n !== null) c = a.n !== null ? -1 : 1;
    else c = a.t.localeCompare(b.t, "fr");
    return c * signe || a.i - b.i;
  });
  return cles.map((c) => c.l);
}
