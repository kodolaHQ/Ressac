import type { ImageRef, LinkRef } from "@webaios/kernel";

/** The action and run whose page is drawn: links and images need them. */
export type PageContext = { action: string; run: string };
export type { ImageRef, LinkRef };
/** A rendered collection: its items, or its sections (reference ended by `regrouper`), and what was cut. */
export type Collection<T> = { items?: T[]; groups?: { value: string; items: T[] }[]; others: number };
/** A collection's sections: just one, untitled, when it is not grouped. */
export const sections = <T>(c: Collection<T>): { value: string | null; items: T[] }[] => c.groups ?? [{ value: null, items: c.items ?? [] }];
const FORMAT = new Intl.NumberFormat("fr-FR");
/** Under a truncated collection. */
export const andOthers = (n: number) => `… et ${FORMAT.format(n)} autre${n > 1 ? "s" : ""}`;
