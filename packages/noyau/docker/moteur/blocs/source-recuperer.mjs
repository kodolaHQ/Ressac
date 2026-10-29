// source.recuperer : GET public (texte ou JSON) par l'appel `recuperer` d'aujourd'hui.

async function recuperer({ parametres, remplir, webaios }) {
  const { texte: url } = remplir(parametres.url, { url: true });
  return webaios.recuperer(url, { format: parametres.format ?? "texte" });
}

export default {
  parElement: "option",
  async executer(ctx) {
    return { sortie: await recuperer(ctx) };
  },
  traiterElement: recuperer,
};
