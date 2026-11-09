// ia.trier: Kev scores each item (one question per item, today's `kev` call), then the block keeps
// those whose score reaches the threshold, sorted by descending score, the score rounded to 2 decimals.
// The filled-in text (coming from a page) is the state Kev scores, never an instruction.

export default {
  parElement: "toujours",
  // No score at all (Kev down): the sort fails clearly rather than returning an empty list.
  echecSiTousEchouent: true,
  async traiterElement({ parametres, remplir, webaios }) {
    const { texte: state } = remplir(parametres.texte);
    const { texte: instructions } = remplir(parametres.question);
    const r = await webaios.kev(state, { q: { type: "noul", instructions } });
    const brute = r?.q?.noul;
    // Like `Number(...)` today, a number written as text is read; nothing, or anything else, is not a score.
    const p = typeof brute === "number" ? brute : typeof brute === "string" && brute.trim() !== "" ? Number(brute) : NaN;
    if (!Number.isFinite(p)) throw new Error("Kev n'a pas rendu de note");
    // The raw score is kept (and reused): the threshold applies to it, as today.
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
