// liste.nouveaux : les éléments dont la clé n'a pas été vue par ce bloc. Sa mémoire : les clés vues avec la date où
// elles l'ont été pour la dernière fois (`[cle, dateIso]`), de la plus ancienne à la plus récente, au plus CLES_MAX.
// Une ancienne mémoire en textes (sans dates) est lue datée de `maintenant` : rien ne réapparaît d'un coup. Avec
// `garderJours`, une clé vue il y a plus longtemps est oubliée : elle redevient nouvelle et n'est pas réécrite.
import { lireChemin } from "../gabarits.mjs";

export const CLES_MAX = 5000;
/** Une clé plus longue est gardée (et comparée) coupée à cette longueur. */
export const CLE_LONGUEUR_MAX = 500;
export const JOUR_MS = 86_400_000;

/** La clé retenue pour une valeur (coupée à CLE_LONGUEUR_MAX) ; null si absente. */
export const enCle = (v) =>
  v === undefined || v === null || v === ""
    ? null
    : (typeof v === "object" ? JSON.stringify(v) : String(v)).slice(0, CLE_LONGUEUR_MAX);

/** Les clés retenues, par clé, avec leur date ; dans l'ordre de la mémoire (une clé en double garde sa dernière place). */
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
      // Un élément sans clé ne peut pas être reconnu la fois suivante : il passe, sans être retenu.
      if (cle === null) {
        sansCle++;
        return true;
      }
      // Déjà vue avant, ou déjà passée plus haut dans cette liste : pas nouvelle.
      const nouvelle = !vues.has(cle) && !vuesCetteFois.has(cle);
      vuesCetteFois.add(cle);
      if (nouvelle) nouvelles.push(cle);
      return nouvelle;
    });
    if (sansCle) journal(`${sansCle} élément(s) sans clé ${parametres.cle}, gardés`);
    // Les clés revues cette fois deviennent les plus récentes, datées de maintenant (une annonce toujours en ligne ne
    // revient pas) ; les plus anciennes sont oubliées au-delà de CLES_MAX.
    const cles = [
      ...[...vues].filter(([c]) => !vuesCetteFois.has(c)),
      ...[...vuesCetteFois].map((c) => [c, instant]),
    ].slice(-CLES_MAX);
    return { sortie, memoire: cles, nouvelles };
  },
};
