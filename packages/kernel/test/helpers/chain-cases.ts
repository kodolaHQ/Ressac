// Streaming chain cases: raw workflows (to validate) and expected chain. Shared between the kernel's rule
// (chaineAuFilDeLEau) and the container interpreter's one, which must return the same chain.

type Block = { id: string; type: string; parametres: Record<string, unknown> };
type Link = { de: string; vers: string };

import type { ValidationContext } from "../../src/workflows/validate.js";

export type ChainCase = {
  nom: string;
  brut: { version: 1; blocs: Block[]; liens: Link[] };
  attendu: string[];
  /** What the widget declares (web.chercher requires `web`); the earlier rules without it. */
  contexte?: ValidationContext;
};

const b = (id: string, type: string, params: Record<string, unknown>): Block => ({ id, type, parametres: params });
const page = (id: string, byElement = true) => b(id, "source.page", { url: "https://x.fr/{url}", parElement: byElement });
const fetch = (id: string, byElement = true) => b(id, "source.recuperer", { url: "https://x.fr/{url}/api", parElement: byElement });
const write = (id: string, byElement = true) => b(id, "ia.rediger", { consigne: "Résume : {page}", parElement: byElement });
const search = (id: string, byElement = true) => b(id, "web.chercher", { requete: "{titre} avis", parElement: byElement, champ: "recherche" });
const WEB: ValidationContext = { web: true, dureeMaxMinutes: null, proprietaire: "widget", saisie: false };
const output = (streaming?: boolean) => b("sortie", "sortie", streaming === undefined ? { vers: "widget" } : { vers: "widget", auFilDeLEau: streaming });
const next = (...ids: string[]): Link[] => ids.slice(1).map((id, i) => ({ de: ids[i]!, vers: id }));
const wf = (blocks: Block[], liens: Link[]) => ({ version: 1 as const, blocs: blocks, liens });

/** annonces → nouvelles → tri → top, the common head of the cases. */
const head = [
  b("annonces", "source.flux", { urls: ["https://x.fr/rss"] }),
  b("nouvelles", "liste.nouveaux", { cle: "url" }),
  b("tri", "ia.trier", { question: "Intéressant ?", texte: "{titre}" }),
  b("top", "liste.garder", { nombre: 5 }),
];
const HEAD_LINKS = next("annonces", "nouvelles", "tri", "top");

export const CASE_CHAIN: ChainCase[] = [
  {
    nom: "annonces → nouvelles → tri → top → fiche → infos → avis (tous par élément) → sortie au fil de l'eau",
    brut: wf([...head, page("fiche"), fetch("infos"), write("avis"), output(true)], [...HEAD_LINKS, ...next("top", "fiche", "infos", "avis", "sortie")]),
    attendu: ["fiche", "infos", "avis"],
  },
  {
    nom: "sans auFilDeLEau : vide",
    brut: wf([...head, page("fiche"), fetch("infos"), write("avis"), output()], [...HEAD_LINKS, ...next("top", "fiche", "infos", "avis", "sortie")]),
    attendu: [],
  },
  {
    nom: "auFilDeLEau à false : vide",
    brut: wf([...head, page("fiche"), output(false)], [...HEAD_LINKS, ...next("top", "fiche", "sortie")]),
    attendu: [],
  },
  {
    nom: "ia.trier juste avant la sortie : vide",
    brut: wf([...head, output(true)], [...HEAD_LINKS, { de: "tri", vers: "sortie" }]),
    attendu: [],
  },
  {
    nom: "liste.garder juste avant la sortie : vide",
    brut: wf([...head, output(true)], [...HEAD_LINKS, { de: "top", vers: "sortie" }]),
    attendu: [],
  },
  {
    nom: "un bloc de la chaîne qui alimente aussi un autre bloc arrête la chaîne à lui",
    brut: wf(
      [...head, page("fiche"), fetch("infos"), write("avis"), b("autre", "liste.garder", { nombre: 1 }), output(true)],
      [...HEAD_LINKS, ...next("top", "fiche", "infos", "avis", "sortie"), { de: "infos", vers: "autre" }],
    ),
    attendu: ["avis"],
  },
  {
    nom: "un bloc par élément avec parElement false arrête la chaîne",
    brut: wf([...head, page("fiche"), fetch("infos", false), write("avis"), output(true)], [...HEAD_LINKS, ...next("top", "fiche", "infos", "avis", "sortie")]),
    attendu: ["avis"],
  },
  {
    nom: "sortie à deux prédécesseurs : vide",
    brut: wf(
      [...head, page("fiche"), write("avis"), output(true)],
      [...HEAD_LINKS, ...next("top", "fiche", "sortie"), { de: "top", vers: "avis" }, { de: "avis", vers: "sortie" }],
    ),
    attendu: [],
  },
  {
    nom: "un bloc chaînable à deux prédécesseurs est pris, la chaîne s'arrête après lui",
    brut: wf(
      [...head, b("autres", "source.flux", { urls: ["https://y.fr/rss"] }), page("fiche"), write("avis"), output(true)],
      [...HEAD_LINKS, { de: "top", vers: "fiche" }, { de: "autres", vers: "fiche" }, ...next("fiche", "avis", "sortie")],
    ),
    attendu: ["fiche", "avis"],
  },
  {
    nom: "tranche non contiguë dans ordre : les premiers blocs sont retirés",
    // « isole » (without a link) sits between fiche and avis in the run order.
    brut: wf(
      [...head, page("fiche"), b("isole", "source.flux", { urls: ["https://z.fr/rss"] }), fetch("infos"), write("avis"), output(true)],
      [...HEAD_LINKS, ...next("top", "fiche", "infos", "avis", "sortie")],
    ),
    attendu: ["infos", "avis"],
  },
  {
    nom: "web.chercher par élément dans la chaîne : top → chercher → avis → sortie",
    brut: wf([...head, search("chercher"), write("avis"), output(true)], [...HEAD_LINKS, ...next("top", "chercher", "avis", "sortie")]),
    attendu: ["chercher", "avis"],
    contexte: WEB,
  },
  {
    nom: "web.chercher sans parElement arrête la chaîne",
    brut: wf([...head, search("chercher", false), write("avis"), output(true)], [...HEAD_LINKS, ...next("top", "chercher", "avis", "sortie")]),
    attendu: ["avis"],
    contexte: WEB,
  },
];
