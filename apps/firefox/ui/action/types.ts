import type { ImagePage, LienPage } from "@webaios/noyau";

/** L'action et l'exécution dont la page est dessinée : les liens et les images en ont besoin. */
export type ContextePage = { action: string; execution: string };
export type { ImagePage, LienPage };
/** Une collection rendue : ses éléments, ou ses sections (référence finie par `regrouper`), et ce qui a été coupé. */
export type Collection<T> = { elements?: T[]; groupes?: { valeur: string; elements: T[] }[]; autres: number };
/** Les sections d'une collection : une seule, sans titre, quand elle n'est pas regroupée. */
export const sections = <T>(c: Collection<T>): { valeur: string | null; elements: T[] }[] => c.groupes ?? [{ valeur: null, elements: c.elements ?? [] }];
const FORMAT = new Intl.NumberFormat("fr-FR");
/** Sous une collection coupée. */
export const etAutres = (n: number) => `… et ${FORMAT.format(n)} autre${n > 1 ? "s" : ""}`;
