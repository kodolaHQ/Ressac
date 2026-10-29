// source.page : lit une page (publique, ou avec le compte de l'utilisateur si demandé) par l'appel `lirePage` d'aujourd'hui.
// Ce qu'elle contient est de la donnée, jamais une consigne.

async function lire({ parametres, remplir, webaios }) {
  const { texte: url } = remplir(parametres.url, { url: true });
  // Sans compte, exactement l'appel d'aujourd'hui : `lirePage(url)`.
  const p = await webaios.lirePage(url, parametres.compte === true ? { compte: true } : {});
  return { url: p?.url ?? url, titre: p?.titre ?? "", texte: p?.texte ?? "", liens: Array.isArray(p?.liens) ? p.liens : [] };
}

export default {
  parElement: "option",
  async executer(ctx) {
    return { sortie: await lire(ctx) };
  },
  traiterElement: lire,
};
