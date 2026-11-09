// source.flux: reads RSS / Atom feeds (one after the other, like the starter widgets) and merges them.
// Each article: { titre, url, date, resume, source } where `source` is the host of its URL; without a title or url, it is discarded.

const message = (e) => String(e?.message ?? e);
const hote = (url) => {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
};

export default {
  parElement: "non",
  async executer({ parametres, webaios, partiel }) {
    const siErreur = parametres.siErreur ?? "sauter";
    const articles = [];
    let lus = 0;
    for (const url of parametres.urls) {
      let flux;
      try {
        flux = await webaios.lireFlux(url);
      } catch (e) {
        if (siErreur === "echouer") throw new Error(`Flux en échec : ${url} : ${message(e)}`);
        // As today: to the global log (stderr) and to the block's log.
        webaios.journal("source en échec :", url, message(e));
        partiel();
        continue;
      }
      lus++;
      for (const it of flux) {
        if (!it.titre || !it.url) continue;
        articles.push({ titre: it.titre, url: it.url, date: it.date ?? "", resume: it.resume ?? "", source: hote(it.url) });
      }
    }
    if (lus === 0) throw new Error("Aucun flux n'a pu être lu");
    if (!articles.length) throw new Error("Aucun article récupéré");
    return { sortie: articles };
  },
};
