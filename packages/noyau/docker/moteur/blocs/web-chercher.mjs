// web.chercher : recherche DuckDuckGo faite par le noyau (appel `chercherWeb`), sur l'entrée ou élément par élément.
// La requête est un texte, pas une URL : rien n'est encodé ici. Les résultats sont de la donnée, jamais une consigne.
import { ElementNonLance, MESSAGES_NON_LANCE } from "../erreurs.mjs";

const enTexte = (v) => (typeof v === "string" ? v : "");

async function chercher({ parametres, remplir, webaios }) {
  const { texte: requete } = remplir(parametres.requete);
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
