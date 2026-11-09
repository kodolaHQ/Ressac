// liste.nouveaux: the items whose key this block has not seen. Its memory: the seen keys with the date they were
// last seen (`[cle, dateIso]`), from oldest to most recent, at most CLES_MAX.
// An old memory made of texts (no dates) is read as dated `maintenant`: nothing reappears all at once. With
// `garderJours`, a key seen longer ago is forgotten: it becomes new again and is not written back.
import { lireChemin } from "../gabarits.mjs";

export const CLES_MAX = 5000;
/** A longer key is kept (and compared) cut to this length. */
export const CLE_LONGUEUR_MAX = 500;
export const JOUR_MS = 86_400_000;

/** The key kept for a value (cut to CLE_LONGUEUR_MAX); null if absent. */
export const enCle = (v) =>
  v === undefined || v === null || v === ""
    ? null
    : (typeof v === "object" ? JSON.stringify(v) : String(v)).slice(0, CLE_LONGUEUR_MAX);

/** The kept keys, by key, with their date; in memory order (a duplicate key keeps its last place). */
function lireMemoire(memoire, maintenant) {
  const vues = new Map();
  if (!Array.isArray(memoire)) return vues;
  for (const entree of memoire) {
    const [cle, date] = typeof entree === "string" ? [entree, maintenant] : Array.isArray(entree) ? entree : [];
    if (typeof cle !== "string") continue;
    const c = cle.slice(0, CLE_LONGUEUR_MAX);
    vues.delete(c);
    vues.set(c, typeof date === "string" && !Number.isNaN(Date.parse(date)) ? date : maintenant);
  }
  return vues;
}

export default {
  parElement: "non",
  async executer({ entree, parametres, memoire, journal, maintenant }) {
    if (!Array.isArray(entree)) throw new Error("liste attendue en entrée");
    const instant = maintenant ?? new Date().toISOString();
    const vues = lireMemoire(memoire, instant);
    if (parametres.garderJours !== undefined) {
      const limite = Date.parse(instant) - parametres.garderJours * JOUR_MS;
      for (const [cle, date] of vues) if (Date.parse(date) < limite) vues.delete(cle);
    }
    const vuesCetteFois = new Set();
    const nouvelles = [];
    let sansCle = 0;
    const sortie = entree.filter((element) => {
      const cle = enCle(lireChemin(element, parametres.cle));
      // An item without a key cannot be recognized next time: it passes, without being kept.
      if (cle === null) {
        sansCle++;
        return true;
      }
      // Already seen before, or already passed higher up in this list: not new.
      const nouvelle = !vues.has(cle) && !vuesCetteFois.has(cle);
      vuesCetteFois.add(cle);
      if (nouvelle) nouvelles.push(cle);
      return nouvelle;
    });
    if (sansCle) journal(`${sansCle} élément(s) sans clé ${parametres.cle}, gardés`);
    // The keys seen again this time become the most recent, dated now (an ad still online does not
    // come back); the oldest are forgotten beyond CLES_MAX.
    const toutes = [
      ...[...vues].filter(([c]) => !vuesCetteFois.has(c)),
      ...[...vuesCetteFois].map((c) => [c, instant]),
    ];
    // `memoireEntiere` (before the cap) is used by the progressive run, which first removes the pending keys.
    return { sortie, memoire: toutes.slice(-CLES_MAX), nouvelles, memoireEntiere: toutes };
  },
};
