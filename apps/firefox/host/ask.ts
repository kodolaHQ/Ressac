import type { LocalAi } from "../../../packages/kernel/src/index.ts";
import type { History } from "../core/history.ts";
import type { AskHit, AskResult } from "../shared/model.ts";

// The ⌘T bar's Demander mode: Gemma turns a question into groups of words and dates, the history is searched with them.
// Not shared/i18n.ts (import.meta.glob, Vite only): the host runs under tsx, so the prompt's two languages live here.

const AGENT: AskResult = { kind: "agent" };
const VIDEO_WORDS = /\b(vid[ée]os?|youtube)\b/i;
const VIDEO_SITES = ["youtube.com", "vimeo.com", "dailymotion.com"];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const PROMPTS: Record<"fr" | "en", (today: string, weekday: string, question: string) => string> = {
  fr: (today, weekday, question) => `Tu aides à retrouver une page dans l'historique d'un navigateur. Nous sommes le ${weekday} ${today}.
Réponds par un seul objet JSON :
{"kind": "page" ou "other", "groups": [[variantes d'une idée], ...], "since": "AAAA-MM-JJ" (facultatif), "until": "AAAA-MM-JJ" (facultatif), "sites": [domaines] (facultatif)}
- "page" si l'utilisateur cherche une page qu'il a déjà vue, sinon "other" (et rien d'autre).
- "groups" : 1 à 4 idées du sujet, chacune un seul mot ou nom propre ; pour chaque idée 1 à 6 variantes : singulier, pluriel, synonymes, et TOUJOURS la traduction anglaise (beaucoup de pages sont en anglais). La page devra contenir toutes les idées : ne mets que les mots du sujet, jamais le genre de page (vidéo, article, page, site) ni des mots vides.
  Exemple : « la vidéo sur les ponts de Bordeaux » → [["pont", "ponts", "bridge", "bridges"], ["bordeaux"]].
- Dates par rapport à aujourd'hui : « l'autre jour » = les 7 derniers jours (since seul), « hier » = since et until à la date d'hier, « la semaine dernière » = du lundi au dimanche de la semaine passée. Aucune date dite : pas de since ni de until.
- "sites" seulement si la question nomme un genre de site : vidéo → ["youtube.com", "vimeo.com", "dailymotion.com"].
Question : ${question}`,
  en: (today, weekday, question) => `You help find a page in a browser's history. Today is ${weekday} ${today}.
Answer with a single JSON object:
{"kind": "page" or "other", "groups": [[variants of one idea], ...], "since": "YYYY-MM-DD" (optional), "until": "YYYY-MM-DD" (optional), "sites": [domains] (optional)}
- "page" if the user looks for a page they already saw, otherwise "other" (and nothing else).
- "groups": 1 to 4 ideas of the subject, each a single word or proper name; for each idea 1 to 6 variants: singular, plural, synonyms, and the translation in the user's other likely language. The page must hold every idea: only subject words, never the kind of page (video, article, page, site) nor stop words.
  Example: "the video about Bordeaux bridges" → [["bridge", "bridges", "pont", "ponts"], ["bordeaux"]].
- Dates relative to today: "the other day" = the last 7 days (since only), "yesterday" = since and until both yesterday's date, "last week" = Monday to Sunday of the previous week. No date said: no since nor until.
- "sites" only when the question names a kind of site: video → ["youtube.com", "vimeo.com", "dailymotion.com"].
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
function parse(answer: unknown): { groups: string[][]; since?: Date; until?: Date; sites: string[] } | null {
  let a = answer;
  if (typeof a === "string") {
    try { a = JSON.parse(a); } catch { return null; }
  }
  if (!a || typeof a !== "object") return null;
  const o = a as Record<string, unknown>;
  if (o.kind !== "page" || !Array.isArray(o.groups) || o.groups.length < 1 || o.groups.length > 4) return null;
  const isGroup = (g: unknown) => Array.isArray(g) && g.length >= 1 && g.length <= 6 && g.every((w) => typeof w === "string" && w.trim());
  if (!o.groups.every(isGroup)) return null;
  const groups = (o.groups as string[][]).map((g) => g.map((w) => w.trim().slice(0, 40)));
  const since = o.since === undefined ? undefined : day(o.since);
  const until = o.until === undefined ? undefined : day(o.until, true);
  if (since === null || until === null) return null;
  // Hints only rank: a bad value is dropped, not a reason to give up.
  const sites = Array.isArray(o.sites) && o.sites.every((s) => typeof s === "string") ? (o.sites as string[]).map((s) => s.trim().toLowerCase()).filter(Boolean) : [];
  return { groups, since, until, sites };
}

export function createAsk(o: {
  ai: Pick<LocalAi, "gemma" | "hasGemma" | "warm">;
  history: () => Pick<History, "findPages"> | null;
  now?: () => Date;
  timeoutMs?: number;
}) {
  const now = o.now ?? (() => new Date());
  const timeoutMs = o.timeoutMs ?? 4000;
  return {
    async usable(): Promise<boolean> {
      return o.ai.hasGemma().catch(() => false);
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
      // The kind of site the user named filters: « une vidéo » is not a blog post. Not left to the model alone: it forgets.
      const sites = VIDEO_WORDS.test(question) ? [...new Set([...q.sites, ...VIDEO_SITES])] : q.sites;
      const hits: AskHit[] = history
        .findPages({ groups: q.groups, since: q.since, until: q.until, sites, limit: 3 })
        .map((r) => ({ url: r.url, title: r.title, lastVisit: r.lastVisit, excerpt: r.excerpt || null }));
      return hits.length ? { kind: "page", hits } : AGENT;
    },
  };
}
