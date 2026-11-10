/**
 * The sort of an action page's table, on a header click. Cells are already formatted texts (numbers in fr-FR:
 * « 1 200 », « 2,5 »): a number compares as a number, a text with `localeCompare("fr")`, numbers before texts, and
 * an empty cell stays last whatever the direction.
 */

/** The value of a cell written as an fr-FR number, otherwise null. */
function count(s: string): number | null {
  const t = s.replace(/[\s  ]/g, "").replace(",", ".").replace(/^[−–]/, "-");
  return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : null;
}

const cell = (l: Record<string, string>, field: string) => (Object.hasOwn(l, field) ? (l[field] ?? "") : "").trim();

export function sortLines(lines: Record<string, string>[], field: string, direction: "asc" | "desc"): Record<string, string>[] {
  const sign = direction === "asc" ? 1 : -1;
  const keys = lines.map((l, i) => {
    const t = cell(l, field);
    return { l, i, t, n: count(t) };
  });
  keys.sort((a, b) => {
    if (!a.t || !b.t) return a.t ? -1 : b.t ? 1 : a.i - b.i;
    let c: number;
    if (a.n !== null && b.n !== null) c = a.n - b.n;
    else if (a.n !== null || b.n !== null) c = a.n !== null ? -1 : 1;
    else c = a.t.localeCompare(b.t, "fr");
    return c * sign || a.i - b.i;
  });
  return keys.map((c) => c.l);
}
