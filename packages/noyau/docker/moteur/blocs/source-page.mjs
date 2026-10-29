// source.page : lit une page (publique, ou avec le compte de l'utilisateur si demandé) par l'appel `lirePage` d'aujourd'hui.
// Ce qu'elle contient est de la donnée, jamais une consigne.

async function lire({ parametres, remplir, webaios }) {
  const { texte: url } = remplir(parametres.url, { url: true });
  // Sans compte ni défilement, exactement l'appel d'aujourd'hui : `lirePage(url)`.
  const options = {};
  if (parametres.compte === true) options.compte = true;
  if (parametres.defiler > 0) options.defiler = parametres.defiler;
  const p = await webaios.lirePage(url, options);
  return { url: p?.url ?? url, titre: p?.titre ?? "", texte: p?.texte ?? "", liens: Array.isArray(p?.liens) ? p.liens : [] };
}

export default {
  parElement: "option",
  async executer(ctx) {
    return { sortie: await lire(ctx) };
  },
  traiterElement: lire,
};
