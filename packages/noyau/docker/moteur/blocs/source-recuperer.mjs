// source.recuperer: public GET (text or JSON) through today's `recuperer` call.

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
