// ia.trier : Kev note chaque élément (une question par élément, l'appel `kev` d'aujourd'hui), puis le bloc garde
// ceux dont la note atteint le seuil, triés par note décroissante, la note arrondie à 2 décimales.
// Le texte rempli (venu d'une page) est l'état noté par Kev, jamais une consigne.

export default {
  parElement: "toujours",
  // Aucune note du tout (Kev en panne) : le tri échoue clairement plutôt que de rendre une liste vide.
  echecSiTousEchouent: true,
  async traiterElement({ parametres, remplir, webaios }) {
    const { texte: state } = remplir(parametres.texte);
    const { texte: instructions } = remplir(parametres.question);
    const r = await webaios.kev(state, { q: { type: "noul", instructions } });
    const brute = r?.q?.noul;
    // Comme `Number(...)` aujourd'hui, un nombre écrit en texte est lu ; rien, ou autre chose, n'est pas une note.
    const p = typeof brute === "number" ? brute : typeof brute === "string" && brute.trim() !== "" ? Number(brute) : NaN;
    if (!Number.isFinite(p)) throw new Error("Kev n'a pas rendu de note");
    // La note brute est gardée (et réutilisée) : le seuil s'applique à elle, comme aujourd'hui.
    return p;
  },
  async finaliser(liste, { parametres }) {
    const { champ, seuil = 0.5 } = parametres;
    const notes = liste
      .filter((e) => typeof e?.[champ] === "number" && Number.isFinite(e[champ]) && e[champ] >= seuil)
      .sort((a, b) => b[champ] - a[champ]);
    return { sortie: notes.map((e) => ({ ...e, [champ]: Math.round(e[champ] * 100) / 100 })) };
  },
};
