import type { ImageRef, LinkRef } from "@ressac/kernel";
import { t } from "../i18n.svelte";

/** What a drawn page's links and images go through: the host checks them against the page's own (action run or recap). */
export type PageContext = { openLink(url: string): void; image(url: string): Promise<string | null> };
/** An action run's page: links and images are allowed only if their address is in that run's results (host checks). */
export const actionContext = (action: string, run: string): PageContext => ({
  openLink: (url) => window.ressac.actions.openLink(action, run, url),
  image: (url) => window.ressac.actions.image(action, run, url),
});
export type { ImageRef, LinkRef };
/** A rendered collection: its items, or its sections (reference ended by `regrouper`), and what was cut. */
export type Collection<T> = { items?: T[]; groups?: { value: string; items: T[] }[]; others: number };
/** A collection's sections: just one, untitled, when it is not grouped. */
export const sections = <T>(c: Collection<T>): { value: string | null; items: T[] }[] => c.groups ?? [{ value: null, items: c.items ?? [] }];
/** Under a truncated collection. */
export const andOthers = (n: number) => t("action-others", { count: n });
