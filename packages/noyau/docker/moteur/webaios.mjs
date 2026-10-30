// L'API `webaios` donnée au code des widgets (recolte.mjs, blocs `code`) : chaque accès passe par un appel au noyau.
import { analyserFlux } from "./flux.mjs";

/** Une ligne de journal : textes tels quels, le reste en JSON. */
export const formater = (...a) => a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ");

/**
 * `appeler(f, a)` envoie un appel au noyau et attend sa réponse ; `journal(...a)` reçoit les lignes de
 * `webaios.journal` ; `saisie` (action seulement) devient `webaios.saisie`.
 */
export function creerWebaios({ appeler, config, precedent, maintenant, journal, saisie }) {
  async function trier(elements, { question, texte, seuil = 0.5, parallele = 8 } = {}) {
    const liste = [...elements];
    const notes = new Array(liste.length);
    let suivant = 0;
    async function ouvrier() {
      while (suivant < liste.length) {
        const i = suivant++;
        const r = await appeler("kev", { state: String(texte(liste[i])), questions: { q: { type: "noul", instructions: question } } });
        const p = Number(r?.q?.noul);
        notes[i] = Number.isFinite(p) ? p : 0;
      }
    }
    await Promise.all(Array.from({ length: Math.max(1, Math.min(parallele, liste.length)) }, ouvrier));
    return liste
      .map((element, i) => ({ element, p: notes[i] }))
      .filter((x) => x.p >= seuil)
      .sort((a, b) => b.p - a.p);
  }

  return {
    config,
    precedent,
    maintenant,
    // Action lancée avec un texte seulement : absente pour un widget.
    ...(typeof saisie === "string" ? { saisie } : {}),
    lirePage: (url, options = {}) => appeler("lirePage", { url, compte: options.compte, defiler: options.defiler }),
    recuperer: (url, options = {}) => appeler("recuperer", { url, format: options.format ?? "texte" }),
    chercherWeb: (requete, { nombre = 8 } = {}) => appeler("chercherWeb", { requete, nombre }),
    lireFlux: async (url) => analyserFlux(String(await appeler("recuperer", { url, format: "texte" }))),
    kev: (state, questions) => appeler("kev", { state, questions }),
    gemma: (prompt, options = {}) => appeler("gemma", { prompt, images: options.images, json: options.json }),
    trier,
    journal,
  };
}
