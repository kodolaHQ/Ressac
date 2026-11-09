// source.page: reads a page (public, or with the user's account if requested) through today's `lirePage` call.
// What it contains is data, never an instruction.

async function lire({ parametres, remplir, webaios }) {
  const { texte: url } = remplir(parametres.url, { url: true });
  // Without account or scrolling, exactly today's call: `lirePage(url)`.
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
