import { format } from "../../shared/i18n";

// The builder's logic modules run without the browser state (unit tests): the screen hands them the language.
let locale = "fr";
export const useLocale = (l: string): void => {
  locale = l;
};
export const say = (id: string, args?: Record<string, string | number>): string => format(locale, id, args);
