// liste.dedoublonner : le premier est gardé ; un élément est un doublon si l'une de ses clés normalisées est déjà vue.
import { lireChemin } from "../gabarits.mjs";
import { cleNormalisee } from "../normaliser.mjs";

export default {
  parElement: "non",
  async executer({ entree, parametres }) {
    if (!Array.isArray(entree)) throw new Error("liste attendue en entrée");
    const vues = parametres.cles.map(() => new Set());
    const sortie = [];
    for (const element of entree) {
      const cles = parametres.cles.map((chemin) => cleNormalisee(lireChemin(element, chemin)));
      if (cles.some((c, i) => c && vues[i].has(c))) continue;
      cles.forEach((c, i) => c && vues[i].add(c));
      sortie.push(element);
    }
    return { sortie };
  },
};
