/** The search engines offered in Réglages, in menu order; `custom` is the user's own address. */
export const SEARCH_ENGINES = {
  google: { label: "Google", url: "https://www.google.com/search?q=%s" },
  duckduckgo: { label: "DuckDuckGo", url: "https://duckduckgo.com/?q=%s" },
  qwant: { label: "Qwant", url: "https://www.qwant.com/?q=%s" },
  bing: { label: "Bing", url: "https://www.bing.com/search?q=%s" },
  ecosia: { label: "Ecosia", url: "https://www.ecosia.org/search?q=%s" },
  brave: { label: "Brave Search", url: "https://search.brave.com/search?q=%s" },
  startpage: { label: "Startpage", url: "https://www.startpage.com/search?q=%s" },
} as const;

export type SearchEngine = keyof typeof SEARCH_ENGINES | "custom";
export const SEARCH_ENGINE_IDS = ["google", "duckduckgo", "qwant", "bing", "ecosia", "brave", "startpage", "custom"] as const satisfies readonly SearchEngine[];
export const CUSTOM_ENGINE_MAX = 2000;

/** Why a custom search address is refused (French, shown under the field), or null when it is fine. */
export function customEngineError(url: string): string | null {
  const text = url.trim();
  if (text.length > CUSTOM_ENGINE_MAX) return "Adresse trop longue";
  if (!/^https:\/\//i.test(text) || !URL.canParse(text)) return "L'adresse doit commencer par https://";
  if (!text.includes("%s")) return "Il manque %s à la place des mots cherchés";
  return null;
}

/** The address a search goes to, `%s` standing for the words; a custom engine without a valid address searches with Google. */
export function searchTemplate(s: { engine: SearchEngine; customEngine: string | null }): string {
  if (s.engine !== "custom") return SEARCH_ENGINES[s.engine].url;
  return s.customEngine && !customEngineError(s.customEngine) ? s.customEngine.trim() : SEARCH_ENGINES.google.url;
}
