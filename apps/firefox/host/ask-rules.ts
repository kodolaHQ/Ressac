// A ⌘T question read by code (fr + en): the period it names, video sites, whether it asks for an action rather than a
// page, and the question without its period words (what is embedded). Port of the measured bench-cmdt/v4/rules.py.
// A period not understood is no filter, never a failure.

const VIDEO_WORDS = /\b(vid[ée]os?|youtube)\b/i;
const VIDEO_SITES = ["youtube.com", "vimeo.com", "dailymotion.com"];

/** Lower case, accents and curly apostrophes dropped, one character for one: a match's span cuts the original question. */
const fold = (s: string) =>
  Array.from(s, (c) => {
    const f = c.replace("’", "'").toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
    return f.length === c.length ? f : c;
  }).join("");

const NUM: Record<string, number> = {
  un: 1, une: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, six: 6, sept: 7, huit: 8, neuf: 9, dix: 10,
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, seven: 7, eight: 8, nine: 9, ten: 10,
};
/** Monday = 0, as Python's weekday(). */
const DAYS: Record<string, number> = {
  lundi: 0, mardi: 1, mercredi: 2, jeudi: 3, vendredi: 4, samedi: 5, dimanche: 6,
  monday: 0, tuesday: 1, wednesday: 2, thursday: 3, friday: 4, saturday: 5, sunday: 6,
};
const N = `(\\d+|${Object.keys(NUM).join("|")})`;
const DAY_NAMES = Object.keys(DAYS).join("|");

type Day = Date; // local midnight
const add = (d: Day, n: number): Day => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const weekday = (d: Day) => (d.getDay() + 6) % 7;
const weekStart = (d: Day) => add(d, -weekday(d));
/** The most recent such weekday before today (today's weekday: a week ago). */
const lastWeekday = (d: Day, wd: number) => add(d, -((((weekday(d) - wd) % 7) + 7) % 7 || 7));
const count = (s: string) => (/^\d+$/.test(s) ? Number(s) : NUM[s]!);

/** First match wins, so longer phrases come first. */
const PERIODS: [RegExp, (d: Day, m: RegExpMatchArray) => [Day, Day | undefined]][] = [
  [/\b(avant[- ]hier|the day before yesterday)\b/, (d) => [add(d, -2), add(d, -2)]],
  [/\b(hier|yesterday|last night)\b/, (d) => [add(d, -1), add(d, -1)]],
  [/\b(aujourd'hui|ce matin|ce midi|cet apres-midi|tout a l'heure|today|this morning|this afternoon|earlier today)\b/, (d) => [d, d]],
  [
    /\b(la semaine (derniere|passee|d'avant)|semaine derniere|last week|the previous week|the week before)\b/,
    (d) => [add(weekStart(d), -7), add(weekStart(d), -1)],
  ],
  // The weekend before this week, even on a Saturday or Sunday.
  [/\b(le (week-?end|weekend) (dernier|passe)|last (week-?end|weekend))\b/, (d) => [add(weekStart(d), -2), add(weekStart(d), -1)]],
  [
    /\b(ce (week-?end|weekend)|(this|over the) (week-?end|weekend))\b/,
    (d) => (weekday(d) < 5 ? [lastWeekday(d, 5), add(lastWeekday(d, 5), 1)] : [add(d, -(weekday(d) - 5)), d]),
  ],
  [/\b(cette semaine|this week|earlier this week)\b/, (d) => [weekday(d) ? weekStart(d) : add(d, -7), undefined]],
  [/\b(le mois dernier|le mois passe|last month)\b/, (d) => [new Date(d.getFullYear(), d.getMonth() - 1, 1), new Date(d.getFullYear(), d.getMonth(), 0)]],
  [/\b(ce mois-?ci|this month)\b/, (d) => [new Date(d.getFullYear(), d.getMonth(), 1), undefined]],
  [/\b(il y a une semaine|a week ago)\b/, (d) => [add(d, -8), add(d, -6)]],
  [
    new RegExp(`\\bil y a ${N} jours?\\b|\\b${N} days? ago\\b`),
    (d, m) => {
      const k = count(m[1] ?? m[2]!);
      return [add(d, -(k + 1)), add(d, -(k - 1))];
    },
  ],
  [
    /\b(l'autre jour|l'autre fois|recemment|ces derniers jours|il y a quelques jours|the other day|recently|lately|a few days ago|the past few days)\b/,
    (d) => [add(d, -7), undefined],
  ],
];
const WEEKDAY = new RegExp(`\\b(${DAY_NAMES})( (dernier|passe|last))?\\b|\\blast (${DAY_NAMES})\\b`, "g");
/** « vus mardi »: the day the page was seen, not one of its subject (« le dimanche »). */
const SEEN_BEFORE = /\b(vus?|vues?|lue?s?|ouverte?s?|consultee?s?|visitee?s?|regardee?s?|seen|read|opened|visited|watched)( (le|on))? $/;
/** « la recette du dimanche », « mardi gras »: a bare weekday that names the subject, not a period (« de lundi » is one). */
const SUBJECT_BEFORE = /\bdu $/;
const SUBJECT_AFTER = /^ gras\b/;

function period(t: string, today: Day): { since: Day; until?: Day; at: number; end: number } | null {
  for (const [rx, f] of PERIODS) {
    const m = t.match(rx);
    if (m) {
      const [since, until] = f(today, m);
      return { since, until, at: m.index!, end: m.index! + m[0].length };
    }
  }
  const marked = (x: RegExpMatchArray) => x[2] || x[4] || SEEN_BEFORE.test(t.slice(0, x.index));
  const subject = (x: RegExpMatchArray) => SUBJECT_BEFORE.test(t.slice(0, x.index)) || SUBJECT_AFTER.test(t.slice(x.index! + x[0].length));
  const all = [...t.matchAll(WEEKDAY)].filter((x) => marked(x) || !subject(x));
  // A weekday marked « dernier/last » or after « vu(s)/visité/regardé » wins over a bare one.
  const m = all.find(marked) ?? all[0];
  if (!m) return null;
  const day = lastWeekday(today, DAYS[m[1] ?? m[4]!]!);
  return { since: day, until: day, at: m.index!, end: m.index! + m[0].length };
}

/** An action request: the question starts with an imperative or a question word (not a page recall). */
const ACTIONS = new Set([
  // fr imperatives (with or without -moi / -le / -nous)
  "resume", "ecris", "redige", "traduis", "compare", "ouvre", "ferme", "rappelle", "fais", "donne", "convertis", "calcule",
  "genere", "cree", "mets", "met", "dis", "recopie", "copie", "active", "desactive", "explique", "envoie", "programme",
  "planifie", "ajoute", "supprime", "corrige", "reformule", "propose", "trouve-moi", "cherche-moi", "lance", "joue", "montre-moi",
  "aide-moi", "liste", "prepare", "organise", "range", "telecharge", "imprime", "partage", "note", "commande", "reserve", "ecrire",
  "resumer", "traduire",
  // fr question words
  "combien", "quel", "quelle", "quels", "quelles", "comment", "pourquoi", "qui", "quand", "est-ce", "peux-tu", "pourrais-tu", "sais-tu",
  // en imperatives
  "summarize", "summarise", "write", "draft", "translate", "open", "close", "remind", "make", "give", "convert", "calculate",
  "compute", "generate", "create", "set", "tell", "copy", "turn", "enable", "disable", "explain", "send", "schedule", "add", "delete",
  "fix", "rewrite", "rephrase", "suggest", "play", "show", "help", "list", "book", "order", "download", "print", "share",
  // en question words
  "what's", "whats", "how", "why", "who", "when", "can", "could", "would", "is", "are", "do", "does", "will",
]);
const PAGE_NOUNS = /\b(page|pages|site|sites|article|articles|video|videos|lien|link|onglet|tab|recette|recipe|doc|thread|fil|billet|post|blog|tuto|tutoriel|tutorial|guide|fiche|annonce|listing|review|notes?)\b/;

export function isAction(question: string): boolean {
  const t = fold(question.normalize("NFC")).trim();
  const w = t.match(/[a-z0-9'-]+/g);
  if (!w) return false;
  const first = w[0]!;
  const base = first.replace(/-(moi|le|la|les|nous|lui|en|toi|y)$/, "");
  if (!(ACTIONS.has(first) || ACTIONS.has(base) || (first === "what" && (w[1] === "is" || w[1] === "are")))) return false;
  // A question word followed by a page noun (« what was the site with… ») stays a page search.
  return !(["quel", "quelle", "what", "which", "where"].includes(first) && PAGE_NOUNS.test(t));
}

/** `today`: any time of the local day; the dates are local midnight (since) and the last millisecond of the day (until). */
export function parseAsk(text: string, today: Date): { since?: Date; until?: Date; sites: string[]; action: boolean; rest: string } {
  // Composed first: fold keeps one character for one, so a decomposed accent would stay and miss the word lists.
  const question = text.normalize("NFC");
  const p = period(fold(question), new Date(today.getFullYear(), today.getMonth(), today.getDate()));
  const rest = p ? question.slice(0, p.at) + question.slice(p.end) : question;
  return {
    since: p?.since,
    until: p?.until && new Date(p.until.getFullYear(), p.until.getMonth(), p.until.getDate(), 23, 59, 59, 999),
    sites: VIDEO_WORDS.test(question) ? VIDEO_SITES : [],
    action: isAction(question),
    rest: rest.replace(/\s+/g, " ").trim(),
  };
}
