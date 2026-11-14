import { format } from "../../shared/i18n";

/** The language of an app window's interface: the window has no browser state, its own state carries it. */
export const site = $state({ locale: "fr" });
export const ts = (id: string, args?: Record<string, string>): string => format(site.locale, id, args);
