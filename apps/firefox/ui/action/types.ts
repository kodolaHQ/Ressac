import type { ImagePage, LienPage } from "@webaios/noyau";

/** The action and run whose page is drawn: links and images need them. */
export type ContextePage = { action: string; execution: string };
export type { ImagePage, LienPage };
/** A rendered collection: its items, or its sections (reference ended by `regrouper`), and what was cut. */
export type Collection<T> = { elements?: T[]; groupes?: { valeur: string; elements: T[] }[]; autres: number };
/** A collection's sections: just one, untitled, when it is not grouped. */
export const sections = <T>(c: Collection<T>): { valeur: string | null; elements: T[] }[] => c.groupes ?? [{ valeur: null, elements: c.elements ?? [] }];
const FORMAT = new Intl.NumberFormat("fr-FR");
/** Under a truncated collection. */
export const etAutres = (n: number) => `… et ${FORMAT.format(n)} autre${n > 1 ? "s" : ""}`;
