import { FluentBundle, FluentResource } from "@fluent/bundle";
import { KERNEL_SOURCES } from "./i18n/messages.js";

const REFERENCE = "en";
export const KERNEL_LOCALES: readonly string[] = Object.keys(KERNEL_SOURCES);
export { KERNEL_SOURCES };

const bundles = new Map<string, FluentBundle>();
function bundle(locale: string): FluentBundle | undefined {
  const source = (KERNEL_SOURCES as Record<string, string>)[locale];
  if (source === undefined) return undefined;
  let b = bundles.get(locale);
  if (!b) {
    b = new FluentBundle(locale, { useIsolating: false });
    const errors = b.addResource(new FluentResource(source));
    if (errors.length) console.error(`[i18n] ${locale}:`, ...errors);
    bundles.set(locale, b);
  }
  return b;
}

/** The message `id` in `locale`, else in English, else the id itself. */
export function say(locale: string, id: string, args?: Record<string, string | number>): string {
  for (const l of locale === REFERENCE ? [REFERENCE] : [locale, REFERENCE]) {
    const b = bundle(l);
    const message = b?.getMessage(id);
    if (b && message?.value) return b.formatPattern(message.value, args);
  }
  return id;
}

/** The language's name in English, for a prompt the model reads (« French »). */
export const englishLanguageName = (locale: string): string => new Intl.DisplayNames(["en"], { type: "language" }).of(locale) ?? locale;

/** The line telling an agent which language to reply in; English whatever the language, the model reads it. */
export const replyLanguageLine = (locale: string): string => `Always reply to the user in ${englishLanguageName(locale)}, whatever language the instructions are written in.`;
