// Streaming chain cases: raw workflows (to validate) and expected chain. Shared between the kernel's rule
// (streamingChain) and the container interpreter's one, which must return the same chain.

type Block = { id: string; type: string; params: Record<string, unknown> };
type Link = { from: string; to: string };

import type { ValidationContext } from "../../src/workflows/validate.js";

export type ChainCase = {
  name: string;
  raw: { version: 1; blocks: Block[]; links: Link[] };
  expected: string[];
  /** What the widget declares (web.chercher requires `web`); the earlier rules without it. */
  context?: ValidationContext;
};

const b = (id: string, type: string, params: Record<string, unknown>): Block => ({ id, type, params: params });
const page = (id: string, byElement = true) => b(id, "source.page", { url: "https://x.fr/{url}", perItem: byElement });
const fetch = (id: string, byElement = true) => b(id, "source.fetch", { url: "https://x.fr/{url}/api", perItem: byElement });
const write = (id: string, byElement = true) => b(id, "ai.write", { prompt: "Résume : {page}", perItem: byElement });
const search = (id: string, byElement = true) => b(id, "web.search", { query: "{title} avis", perItem: byElement, field: "recherche" });
const WEB: ValidationContext = { web: true, maxDurationMinutes: null, owner: "widget", input: false };
const output = (streaming?: boolean) => b("sortie", "output", streaming === undefined ? { to: "widget" } : { to: "widget", live: streaming });
const next = (...ids: string[]): Link[] => ids.slice(1).map((id, i) => ({ from: ids[i]!, to: id }));
const wf = (blocks: Block[], links: Link[]) => ({ version: 1 as const, blocks: blocks, links: links });

/** annonces → nouvelles → tri → top, the common head of the cases. */
const head = [
  b("annonces", "source.feed", { urls: ["https://x.fr/rss"] }),
  b("nouvelles", "list.new", { key: "url" }),
  b("tri", "ai.sort", { question: "Intéressant ?", text: "{title}" }),
  b("top", "list.keep", { count: 5 }),
];
const HEAD_LINKS = next("annonces", "nouvelles", "tri", "top");

export const CASE_CHAIN: ChainCase[] = [
  {
    name: "annonces → nouvelles → tri → top → fiche → infos → avis (tous par élément) → sortie au fil de l'eau",
    raw: wf([...head, page("fiche"), fetch("infos"), write("avis"), output(true)], [...HEAD_LINKS, ...next("top", "fiche", "infos", "avis", "sortie")]),
    expected: ["fiche", "infos", "avis"],
  },
  {
    name: "sans auFilDeLEau : vide",
    raw: wf([...head, page("fiche"), fetch("infos"), write("avis"), output()], [...HEAD_LINKS, ...next("top", "fiche", "infos", "avis", "sortie")]),
    expected: [],
  },
  {
    name: "auFilDeLEau à false : vide",
    raw: wf([...head, page("fiche"), output(false)], [...HEAD_LINKS, ...next("top", "fiche", "sortie")]),
    expected: [],
  },
  {
    name: "ia.trier juste avant la sortie : vide",
    raw: wf([...head, output(true)], [...HEAD_LINKS, { from: "tri", to: "sortie" }]),
    expected: [],
  },
  {
    name: "liste.garder juste avant la sortie : vide",
    raw: wf([...head, output(true)], [...HEAD_LINKS, { from: "top", to: "sortie" }]),
    expected: [],
  },
  {
    name: "un bloc de la chaîne qui alimente aussi un autre bloc arrête la chaîne à lui",
    raw: wf(
      [...head, page("fiche"), fetch("infos"), write("avis"), b("autre", "list.keep", { count: 1 }), output(true)],
      [...HEAD_LINKS, ...next("top", "fiche", "infos", "avis", "sortie"), { from: "infos", to: "autre" }],
    ),
    expected: ["avis"],
  },
  {
    name: "un bloc par élément avec parElement false arrête la chaîne",
    raw: wf([...head, page("fiche"), fetch("infos", false), write("avis"), output(true)], [...HEAD_LINKS, ...next("top", "fiche", "infos", "avis", "sortie")]),
    expected: ["avis"],
  },
  {
    name: "sortie à deux prédécesseurs : vide",
    raw: wf(
      [...head, page("fiche"), write("avis"), output(true)],
      [...HEAD_LINKS, ...next("top", "fiche", "sortie"), { from: "top", to: "avis" }, { from: "avis", to: "sortie" }],
    ),
    expected: [],
  },
  {
    name: "un bloc chaînable à deux prédécesseurs est pris, la chaîne s'arrête après lui",
    raw: wf(
      [...head, b("autres", "source.feed", { urls: ["https://y.fr/rss"] }), page("fiche"), write("avis"), output(true)],
      [...HEAD_LINKS, { from: "top", to: "fiche" }, { from: "autres", to: "fiche" }, ...next("fiche", "avis", "sortie")],
    ),
    expected: ["fiche", "avis"],
  },
  {
    name: "tranche non contiguë dans ordre : les premiers blocs sont retirés",
    // « isole » (without a link) sits between fiche and avis in the run order.
    raw: wf(
      [...head, page("fiche"), b("isole", "source.feed", { urls: ["https://z.fr/rss"] }), fetch("infos"), write("avis"), output(true)],
      [...HEAD_LINKS, ...next("top", "fiche", "infos", "avis", "sortie")],
    ),
    expected: ["infos", "avis"],
  },
  {
    name: "web.chercher par élément dans la chaîne : top → chercher → avis → sortie",
    raw: wf([...head, search("chercher"), write("avis"), output(true)], [...HEAD_LINKS, ...next("top", "chercher", "avis", "sortie")]),
    expected: ["chercher", "avis"],
    context: WEB,
  },
  {
    name: "web.chercher sans parElement arrête la chaîne",
    raw: wf([...head, search("chercher", false), write("avis"), output(true)], [...HEAD_LINKS, ...next("top", "chercher", "avis", "sortie")]),
    expected: ["avis"],
    context: WEB,
  },
];
