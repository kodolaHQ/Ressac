import { canonicalJson } from "../workflows/memory.js";

/**
 * What counts as a widget's novelties: the items of its data (the list, or the first-level lists
 * of an object) that were not in its previous data. A notification's text never takes anything
 * from this data: only their number.
 */

/** The items of the data: the list itself, or the first-level lists of an object, one after the other. */
export function elementsOf(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  if (data === null || typeof data !== "object") return [];
  return Object.values(data).flatMap((v) => (Array.isArray(v) ? v : []));
}

/** An item's identity: its `url` when it is text (a changed price does not make it new), otherwise its canonical JSON. */
export function identity(e: unknown): string {
  if (e !== null && typeof e === "object" && !Array.isArray(e)) {
    const url = (e as Record<string, unknown>).url;
    if (typeof url === "string") return url;
  }
  return canonicalJson(e);
}

/** Number of (distinct) items of the data that were not in the previous ones. */
export function countNew(previous: unknown, data: unknown): number {
  const seen = new Set(elementsOf(previous).map(identity));
  const fresh = new Set(elementsOf(data).map(identity).filter((i) => !seen.has(i)));
  return fresh.size;
}

export function notificationText(n: number): string {
  return n === 1 ? "1 nouvel élément" : `${n} nouveaux éléments`;
}

/** What the notification at the end of a watch shows: `titre` = widget name, `texte` = `texteNotification(n)`. */
export type NotificationWidget = { widget: string; title: string; text: string };
