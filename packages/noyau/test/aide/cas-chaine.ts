// Cas de la chaîne au fil de l'eau : workflows bruts (à valider) et chaîne attendue. Partagés entre la règle du noyau
// (chaineAuFilDeLEau) et celle de l'interpréteur du conteneur, qui doivent rendre la même chaîne.

type Bloc = { id: string; type: string; parametres: Record<string, unknown> };
type Lien = { de: string; vers: string };

import type { ContexteValidation } from "../../src/workflows/valider.js";

export type CasChaine = {
  nom: string;
  brut: { version: 1; blocs: Bloc[]; liens: Lien[] };
  attendu: string[];
  /** Ce que le widget déclare (web.chercher demande `web`) ; les règles d'avant sans lui. */
  contexte?: ContexteValidation;
};

const b = (id: string, type: string, parametres: Record<string, unknown>): Bloc => ({ id, type, parametres });
const page = (id: string, parElement = true) => b(id, "source.page", { url: "https://x.fr/{url}", parElement });
const recuperer = (id: string, parElement = true) => b(id, "source.recuperer", { url: "https://x.fr/{url}/api", parElement });
const rediger = (id: string, parElement = true) => b(id, "ia.rediger", { consigne: "Résume : {page}", parElement });
const chercher = (id: string, parElement = true) => b(id, "web.chercher", { requete: "{titre} avis", parElement, champ: "recherche" });
const WEB: ContexteValidation = { web: true, dureeMaxMinutes: null };
const sortie = (auFilDeLEau?: boolean) => b("sortie", "sortie", auFilDeLEau === undefined ? { vers: "widget" } : { vers: "widget", auFilDeLEau });
const suite = (...ids: string[]): Lien[] => ids.slice(1).map((id, i) => ({ de: ids[i]!, vers: id }));
const wf = (blocs: Bloc[], liens: Lien[]) => ({ version: 1 as const, blocs, liens });

/** annonces → nouvelles → tri → top, la tête commune des cas. */
const tete = [
  b("annonces", "source.flux", { urls: ["https://x.fr/rss"] }),
  b("nouvelles", "liste.nouveaux", { cle: "url" }),
  b("tri", "ia.trier", { question: "Intéressant ?", texte: "{titre}" }),
  b("top", "liste.garder", { nombre: 5 }),
];
const LIENS_TETE = suite("annonces", "nouvelles", "tri", "top");

export const CAS_CHAINE: CasChaine[] = [
  {
    nom: "annonces → nouvelles → tri → top → fiche → infos → avis (tous par élément) → sortie au fil de l'eau",
    brut: wf([...tete, page("fiche"), recuperer("infos"), rediger("avis"), sortie(true)], [...LIENS_TETE, ...suite("top", "fiche", "infos", "avis", "sortie")]),
    attendu: ["fiche", "infos", "avis"],
  },
  {
    nom: "sans auFilDeLEau : vide",
    brut: wf([...tete, page("fiche"), recuperer("infos"), rediger("avis"), sortie()], [...LIENS_TETE, ...suite("top", "fiche", "infos", "avis", "sortie")]),
    attendu: [],
  },
  {
    nom: "auFilDeLEau à false : vide",
    brut: wf([...tete, page("fiche"), sortie(false)], [...LIENS_TETE, ...suite("top", "fiche", "sortie")]),
    attendu: [],
  },
  {
    nom: "ia.trier juste avant la sortie : vide",
    brut: wf([...tete, sortie(true)], [...LIENS_TETE, { de: "tri", vers: "sortie" }]),
    attendu: [],
  },
  {
    nom: "liste.garder juste avant la sortie : vide",
    brut: wf([...tete, sortie(true)], [...LIENS_TETE, { de: "top", vers: "sortie" }]),
    attendu: [],
  },
  {
    nom: "un bloc de la chaîne qui alimente aussi un autre bloc arrête la chaîne à lui",
    brut: wf(
      [...tete, page("fiche"), recuperer("infos"), rediger("avis"), b("autre", "liste.garder", { nombre: 1 }), sortie(true)],
      [...LIENS_TETE, ...suite("top", "fiche", "infos", "avis", "sortie"), { de: "infos", vers: "autre" }],
    ),
    attendu: ["avis"],
  },
  {
    nom: "un bloc par élément avec parElement false arrête la chaîne",
    brut: wf([...tete, page("fiche"), recuperer("infos", false), rediger("avis"), sortie(true)], [...LIENS_TETE, ...suite("top", "fiche", "infos", "avis", "sortie")]),
    attendu: ["avis"],
  },
  {
    nom: "sortie à deux prédécesseurs : vide",
    brut: wf(
      [...tete, page("fiche"), rediger("avis"), sortie(true)],
      [...LIENS_TETE, ...suite("top", "fiche", "sortie"), { de: "top", vers: "avis" }, { de: "avis", vers: "sortie" }],
    ),
    attendu: [],
  },
  {
    nom: "un bloc chaînable à deux prédécesseurs est pris, la chaîne s'arrête après lui",
    brut: wf(
      [...tete, b("autres", "source.flux", { urls: ["https://y.fr/rss"] }), page("fiche"), rediger("avis"), sortie(true)],
      [...LIENS_TETE, { de: "top", vers: "fiche" }, { de: "autres", vers: "fiche" }, ...suite("fiche", "avis", "sortie")],
    ),
    attendu: ["fiche", "avis"],
  },
  {
    nom: "tranche non contiguë dans ordre : les premiers blocs sont retirés",
    // « isole » (sans lien) se place entre fiche et avis dans l'ordre d'exécution.
    brut: wf(
      [...tete, page("fiche"), b("isole", "source.flux", { urls: ["https://z.fr/rss"] }), recuperer("infos"), rediger("avis"), sortie(true)],
      [...LIENS_TETE, ...suite("top", "fiche", "infos", "avis", "sortie")],
    ),
    attendu: ["infos", "avis"],
  },
  {
    nom: "web.chercher par élément dans la chaîne : top → chercher → avis → sortie",
    brut: wf([...tete, chercher("chercher"), rediger("avis"), sortie(true)], [...LIENS_TETE, ...suite("top", "chercher", "avis", "sortie")]),
    attendu: ["chercher", "avis"],
    contexte: WEB,
  },
  {
    nom: "web.chercher sans parElement arrête la chaîne",
    brut: wf([...tete, chercher("chercher", false), rediger("avis"), sortie(true)], [...LIENS_TETE, ...suite("top", "chercher", "avis", "sortie")]),
    attendu: ["avis"],
    contexte: WEB,
  },
];
