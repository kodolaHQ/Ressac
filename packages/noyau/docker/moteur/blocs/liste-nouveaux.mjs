// liste.nouveaux : les éléments dont la clé n'a jamais été vue par ce bloc. Sa mémoire : les clés vues, de la plus
// ancienne à la plus récente, au plus CLES_MAX.
import { lireChemin } from "../gabarits.mjs";

export const CLES_MAX = 5000;

const enCle = (v) => (v === undefined || v === null || v === "" ? null : typeof v === "object" ? JSON.stringify(v) : String(v));

export default {
  parElement: "non",
  async executer({ entree, parametres, memoire, journal }) {
    if (!Array.isArray(entree)) throw new Error("liste attendue en entrée");
    const anciennes = Array.isArray(memoire) ? memoire.filter((c) => typeof c === "string") : [];
    const dejaVues = new Set(anciennes);
    const vuesCetteFois = new Set();
    let sansCle = 0;
    const sortie = entree.filter((element) => {
      const cle = enCle(lireChemin(element, parametres.cle));
      // Un élément sans clé ne peut pas être reconnu la fois suivante : il passe, sans être retenu.
      if (cle === null) {
        sansCle++;
        return true;
      }
      vuesCetteFois.add(cle);
      return !dejaVues.has(cle);
    });
    if (sansCle) journal(`${sansCle} élément(s) sans clé ${parametres.cle}, gardés`);
    // Les clés revues cette fois deviennent les plus récentes ; les plus anciennes sont oubliées au-delà de CLES_MAX.
    const cles = [...anciennes.filter((c) => !vuesCetteFois.has(c)), ...vuesCetteFois].slice(-CLES_MAX);
    return { sortie, memoire: cles };
  },
};
