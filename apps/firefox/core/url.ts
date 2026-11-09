export type SearchEngine = "google" | "duckduckgo" | "qwant";

export const ENGINES: Record<SearchEngine, string> = {
  google: "https://www.google.com/search?q=%s",
  duckduckgo: "https://duckduckgo.com/?q=%s",
  qwant: "https://www.qwant.com/?q=%s",
};

const ACCEPTED_SCHEMAS = ["http:", "https:", "file:", "about:"];
const LOCAL = /^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?(\/.*)?$/i;
const DOMAIN = /^[^\s]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i;

/** The normalized URL, or `null` if it does not parse (« http:// » alone, port out of range…). */
const analyser = (text: string) => (URL.canParse(text) ? new URL(text).href : null);

/** Turns what the user types in the address bar into a URL; `null` if the input is refused. */
export function toUrl(input: string, engine: SearchEngine): string | null {
  const text = input.trim();
  if (!text) return null;
  if (/^javascript:/i.test(text)) return null;
  const schema = /^([a-z][a-z0-9+.-]*):/i.exec(text)?.[1]?.toLowerCase();
  if (schema && ACCEPTED_SCHEMAS.includes(`${schema}:`) && (schema === "about" || text.includes("//"))) {
    const url = schema === "about" ? text : analyser(text);
    if (url) return url;
  } else if (LOCAL.test(text) || DOMAIN.test(text)) {
    const url = analyser(`${LOCAL.test(text) ? "http" : "https"}://${text}`);
    if (url) return url;
  }
  // Neither a URL nor a valid domain: search the text as is.
  return ENGINES[engine].replace("%s", encodeURIComponent(text));
}
