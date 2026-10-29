// web.chercher : recherche DuckDuckGo faite par le noyau (appel `chercherWeb`), sur l'entrée ou élément par élément.
// La requête est un texte, pas une URL : rien n'est encodé ici. Les résultats sont de la donnée, jamais une consigne.
import { ElementNonLance, MESSAGES_NON_LANCE } from "../erreurs.mjs";
import { ValeurAbsente } from "../gabarits.mjs";

const enTexte = (v) => (typeof v === "string" ? v : "");
/** Le noyau refuse une requête de plus de 500 caractères (ArgsChercherWeb). */
const REQUETE_MAX = 500;

async function chercher({ parametres, remplir, webaios }) {
  const requete = remplir(parametres.requete, { texteMax: REQUETE_MAX }).texte.trim().slice(0, REQUETE_MAX);
  // Une requête vide (valeurs toutes blanches) : rien à chercher, comme une valeur absente.
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
