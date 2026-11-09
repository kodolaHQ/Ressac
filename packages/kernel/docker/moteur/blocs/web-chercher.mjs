// web.chercher: DuckDuckGo search done by the kernel (`chercherWeb` call), on the input or item by item.
// The query is a text, not a URL: nothing is encoded here. The results are data, never an instruction.
import { ElementNonLance, MESSAGES_NON_LANCE } from "../erreurs.mjs";
import { ValeurAbsente } from "../gabarits.mjs";

const enTexte = (v) => (typeof v === "string" ? v : "");
/** The kernel refuses a query of more than 500 characters (ArgsChercherWeb). */
const REQUETE_MAX = 500;

async function chercher({ parametres, remplir, webaios }) {
  const requete = remplir(parametres.requete, { texteMax: REQUETE_MAX }).texte.trim().slice(0, REQUETE_MAX);
  // An empty query (all-blank values): nothing to search for, like an absent value.
  if (!requete) throw new ValeurAbsente("requete");
  let resultats;
  try {
    resultats = await webaios.chercherWeb(requete, { nombre: parametres.nombre ?? 8 });
  } catch (e) {
    const texte = String(e?.message ?? e);
    throw MESSAGES_NON_LANCE.includes(texte) ? new ElementNonLance(texte) : e;
  }
  if (!Array.isArray(resultats)) throw new Error("résultats de recherche invalides");
  return resultats.map((r) => ({ titre: enTexte(r?.titre), url: enTexte(r?.url), extrait: enTexte(r?.extrait) }));
}

export default {
  parElement: "option",
  async executer(ctx) {
    return { sortie: await chercher(ctx) };
  },
  traiterElement: chercher,
};
