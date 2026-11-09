// The `webaios` API given to the widgets' code (recolte.mjs, `code` blocks): every access goes through a call to the kernel.
import { analyserFlux } from "./flux.mjs";

/** A log line: texts as they are, the rest as JSON. */
export const formater = (...a) => a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ");

/**
 * `appeler(f, a)` sends a call to the kernel and waits for its answer; `journal(...a)` receives the lines of
 * `webaios.journal`; `saisie` (action only) becomes `webaios.saisie`.
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
    // Action run with a text only: absent for a widget.
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
