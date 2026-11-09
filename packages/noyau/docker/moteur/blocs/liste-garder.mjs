// liste.garder: the first N items.
export default {
  parElement: "non",
  async executer({ entree, parametres }) {
    if (!Array.isArray(entree)) throw new Error("liste attendue en entrée");
    return { sortie: entree.slice(0, parametres.nombre) };
  },
};
