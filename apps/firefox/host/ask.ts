import type { LocalAi } from "../../../packages/kernel/src/index.ts";
import type { History } from "../core/history.ts";
import type { AskHit, AskResult } from "../shared/model.ts";

// The ⌘T bar's Demander mode: Gemma turns a question into search terms and dates, the history is searched with them.
// Not shared/i18n.ts (import.meta.glob, Vite only): the host runs under tsx, so the prompt's two languages live here.

const AGENT: AskResult = { kind: "agent" };
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const PROMPTS: Record<"fr" | "en", (today: string, weekday: string, question: string) => string> = {
  fr: (today, weekday, question) => `Tu aides à retrouver une page dans l'historique d'un navigateur. Nous sommes le ${weekday} ${today}.
Réponds par un seul objet JSON :
{"kind": "page" ou "other", "terms": [1 à 8 mots de recherche], "since": "AAAA-MM-JJ" (facultatif), "until": "AAAA-MM-JJ" (facultatif), "sites": [domaines] (facultatif)}
- "page" si l'utilisateur cherche une page qu'il a déjà vue, sinon "other" (et rien d'autre).
- "terms" : quelques mots, avec pluriel/singulier et variantes dans d'autres langues (« mascaret », « mascarets », « tidal bore »).
- Dates par rapport à aujourd'hui : « l'autre jour » = les 7 derniers jours (since seul), « hier » = since et until à la date d'hier, « la semaine dernière » = du lundi au dimanche de la semaine passée. Aucune date dite : pas de since ni de until.
- "sites" seulement si la question nomme un genre de site : « vidéo » → ["youtube.com", "vimeo.com", "dailymotion.com"].
Question : ${question}`,
  en: (today, weekday, question) => `You help find a page in a browser's history. Today is ${weekday} ${today}.
Answer with a single JSON object:
{"kind": "page" or "other", "terms": [1 to 8 search words], "since": "YYYY-MM-DD" (optional), "until": "YYYY-MM-DD" (optional), "sites": [domains] (optional)}
- "page" if the user looks for a page they already saw, otherwise "other" (and nothing else).
- "terms": a few words, with plural/singular and variants in other languages ("tidal bore", "tidal bores", "mascaret").
- Dates relative to today: "the other day" = the last 7 days (since only), "yesterday" = since and until both yesterday's date, "last week" = Monday to Sunday of the previous week. No date said: no since nor until.
- "sites" only when the question names a kind of site: "video" → ["youtube.com", "vimeo.com", "dailymotion.com"].
Question: ${question}`,
};

const localIso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** A YYYY-MM-DD date as local midnight (or the last millisecond of that day), null if it is not a real date. */
function day(s: unknown, endOfDay = false): Date | null {
  if (typeof s !== "string" || !ISO_DATE.test(s)) return null;
  const [y, m, d] = s.split("-").map(Number) as [number, number, number];
  const date = endOfDay ? new Date(y, m - 1, d, 23, 59, 59, 999) : new Date(y, m - 1, d);
  return date.getMonth() === m - 1 && date.getDate() === d ? date : null;
}

/** Gemma's answer when it asks for a page search, else null (other, or malformed). */
function parse(answer: unknown): { terms: string[]; since?: Date; until?: Date; sites: string[] } | null {
  let a = answer;
  if (typeof a === "string") {
    try { a = JSON.parse(a); } catch { return null; }
  }
  if (!a || typeof a !== "object") return null;
  const o = a as Record<string, unknown>;
  if (o.kind !== "page" || !Array.isArray(o.terms) || o.terms.length < 1 || o.terms.length > 8) return null;
  if (!o.terms.every((t) => typeof t === "string" && t.trim())) return null;
  const terms = (o.terms as string[]).map((t) => t.trim().slice(0, 40));
  const since = o.since === undefined ? undefined : day(o.since);
  const until = o.until === undefined ? undefined : day(o.until, true);
  if (since === null || until === null) return null;
  // Hints only rank: a bad value is dropped, not a reason to give up.
  const sites = Array.isArray(o.sites) && o.sites.every((s) => typeof s === "string") ? (o.sites as string[]).map((s) => s.trim().toLowerCase()).filter(Boolean) : [];
  return { terms, since, until, sites };
}

const onSite = (url: string, sites: string[]) => {
  try {
    const host = new URL(url).hostname;
    return sites.some((s) => host === s || host.endsWith(`.${s}`));
  } catch {
    return false;
  }
};

export function createAsk(o: {
  ai: Pick<LocalAi, "gemma" | "check" | "warm">;
  history: () => Pick<History, "searchForAgent"> | null;
  now?: () => Date;
  timeoutMs?: number;
}) {
  const now = o.now ?? (() => new Date());
  const timeoutMs = o.timeoutMs ?? 4000;
  return {
    async usable(): Promise<boolean> {
      try {
        const c = await o.ai.check();
        return c.ollama && c.gemma;
      } catch {
        return false;
      }
    },
    warm(): void {
      void o.ai.warm();
    },
    async find(question: string, locale: string): Promise<AskResult> {
      const history = o.history();
      if (!history) return AGENT;
      const today = now();
      const lang = locale.startsWith("fr") ? "fr" : "en";
      const prompt = PROMPTS[lang](localIso(today), today.toLocaleDateString(lang, { weekday: "long" }), question);
      const controller = new AbortController();
      let timer: NodeJS.Timeout | undefined;
      // The race does not trust gemma to honour the signal: the answer is given up at the timeout either way.
      const timeout = new Promise<never>((_, no) => (timer = setTimeout(() => (controller.abort(), no(new Error("timeout"))), timeoutMs)));
      let answer: unknown;
      try {
        answer = await Promise.race([o.ai.gemma({ prompt, json: true, signal: controller.signal }), timeout]);
      } catch {
        return AGENT;
      } finally {
        clearTimeout(timer);
      }
      const q = parse(answer);
      if (!q) return AGENT;
      const found = history.searchForAgent({ query: q.terms.join(" "), since: q.since, until: q.until, limit: 20 });
      const hits: AskHit[] = found
        .map((r, i) => ({ r, i, hinted: onSite(r.url, q.sites) }))
        .sort((a, b) => Number(b.hinted) - Number(a.hinted) || a.i - b.i)
        .slice(0, 3)
        .map(({ r }) => ({ url: r.url, title: r.title, lastVisit: r.lastVisit, excerpt: r.excerpt || null }));
      return hits.length ? { kind: "page", hits } : AGENT;
    },
  };
}
