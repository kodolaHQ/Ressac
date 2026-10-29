// ia.rediger : Gemma rédige à partir d'une consigne (gabarit), sur toute l'entrée ou élément par élément, par l'appel
// `gemma` d'aujourd'hui. Chaque valeur insérée est coupée à `texteMax`. Ce qui vient d'une page, et la réponse de
// Gemma, sont de la donnée : la consigne n'est remplie qu'une fois, jamais relue.

async function rediger({ parametres, remplir, webaios }) {
  const { texte: prompt } = remplir(parametres.consigne, { texteMax: parametres.texteMax ?? 12_000 });
  // Sans json, exactement l'appel d'aujourd'hui : `gemma(prompt)`.
  const r = await webaios.gemma(prompt, parametres.json === true ? { json: true } : {});
  if (parametres.json === true) {
    if (r === undefined || r === null) throw new Error("Gemma n'a rien répondu");
    return r;
  }
  const texte = String(r ?? "").trim();
  if (!texte) throw new Error("Gemma n'a rien répondu");
  return texte;
}

export default {
  parElement: "option",
  async executer(ctx) {
    return { sortie: await rediger(ctx) };
  },
  traiterElement: rediger,
};
