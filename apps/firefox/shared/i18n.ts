import { FluentBundle, FluentResource, type FluentVariable } from "@fluent/bundle";
import { negotiateLanguages } from "@fluent/langneg";

/** Every locales/<lang>/*.ftl, bundled at build time: adding a language is adding its folder. */
const FILES = import.meta.glob("../locales/*/*.ftl", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

export type Locale = string;
/** The reference language: every message exists in it, and any missing one is shown in it. */
export const REFERENCE: Locale = "en";

/** The sources of each language, files joined (a message id is unique across a language's files). */
function sourcesOf(files: Record<string, string>): Record<Locale, string> {
  const out: Record<Locale, string> = {};
  for (const [path, text] of Object.entries(files)) {
    const lang = /locales\/([^/]+)\//.exec(path)?.[1];
    if (lang) out[lang] = (out[lang] ?? "") + "\n" + text;
  }
  return out;
}
const SOURCES = sourcesOf(FILES);

/** The shipped languages, the reference first. */
export const LOCALES: readonly Locale[] = [REFERENCE, ...Object.keys(SOURCES).filter((l) => l !== REFERENCE).sort()];

/** The language to show: the one chosen, or with « system » the first of the Mac's languages Ressac has, else English. */
export function resolveLocale(setting: string, system: readonly string[]): Locale {
  if (setting !== "system") return LOCALES.includes(setting) ? setting : REFERENCE;
  return negotiateLanguages([...system], [...LOCALES], { strategy: "lookup", defaultLocale: REFERENCE })[0] ?? REFERENCE;
}

const bundles = new Map<Locale, FluentBundle>();
function bundle(locale: Locale): FluentBundle | undefined {
  if (!SOURCES[locale]) return undefined;
  let b = bundles.get(locale);
  if (!b) {
    // No bidi isolation marks: the shipped languages are left to right (spec: no RTL layout yet).
    b = new FluentBundle(locale, { useIsolating: false });
    const errors = b.addResource(new FluentResource(SOURCES[locale]!));
    if (errors.length) console.error(`[i18n] ${locale}:`, ...errors);
    bundles.set(locale, b);
  }
  return b;
}

/** The message `id` in `locale`, else in English, else the id itself (the tests forbid that). */
export function format(locale: Locale, id: string, args?: Record<string, FluentVariable>): string {
  for (const l of locale === REFERENCE ? [REFERENCE] : [locale, REFERENCE]) {
    const b = bundle(l);
    const message = b?.getMessage(id);
    if (b && message?.value) return b.formatPattern(message.value, args);
  }
  return id;
}

/** A language's name in itself, capitalized (« Français », « English »). */
export function languageName(code: Locale): string {
  const name = new Intl.DisplayNames([code], { type: "language" }).of(code) ?? code;
  return name.charAt(0).toLocaleUpperCase(code) + name.slice(1);
}

/** Message id → the variables it uses, for a language's source. */
function messagesOf(source: string): { messages: Map<string, string[]>; junk: number } {
  const resource = new FluentResource(source) as unknown as { body: { id: string; value: unknown; attributes: unknown }[] };
  const messages = new Map<string, string[]>();
  const vars = (node: unknown, found: Set<string>): Set<string> => {
    if (Array.isArray(node)) node.forEach((n) => vars(n, found));
    else if (node && typeof node === "object") {
      const o = node as Record<string, unknown>;
      if (o.type === "var" && typeof o.name === "string") found.add(o.name);
      Object.values(o).forEach((v) => vars(v, found));
    }
    return found;
  };
  for (const entry of resource.body) messages.set(entry.id, [...vars([entry.value, entry.attributes], new Set())].sort());
  // FluentResource drops unparsable entries: count the message-looking lines it lost.
  const declared = source.split("\n").filter((line) => /^-?[a-zA-Z][\w-]*\s*=/.test(line)).length;
  return { messages, junk: declared - resource.body.length };
}

/** What is wrong with these sources: syntax errors, messages unknown to English, variables that differ, French incomplete. */
export function localeIssuesOf(sources: Record<Locale, string>): string[] {
  const issues: string[] = [];
  const parsed = Object.fromEntries(Object.entries(sources).map(([l, s]) => [l, messagesOf(s)]));
  const reference = parsed[REFERENCE]?.messages ?? new Map<string, string[]>();
  for (const [lang, { messages, junk }] of Object.entries(parsed)) {
    if (junk > 0) issues.push(`${lang}: ${junk} message(s) with a syntax error`);
    if (lang === REFERENCE) continue;
    for (const [id, v] of messages) {
      const ref = reference.get(id);
      if (!ref) issues.push(`${lang}: ${id} is not in ${REFERENCE}`);
      else if (ref.join() !== v.join()) issues.push(`${lang}: ${id} uses { ${v.join(", ")} }, ${REFERENCE} uses { ${ref.join(", ")} }`);
    }
  }
  // French is shipped complete (Ressac was French first); other languages may be partial.
  const fr = parsed.fr?.messages;
  if (fr) for (const id of reference.keys()) if (!id.startsWith("test-") && !fr.has(id)) issues.push(`fr: ${id} is missing`);
  return issues;
}

export const localeIssues = (): string[] => localeIssuesOf(SOURCES);
