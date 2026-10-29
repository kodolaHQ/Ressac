// source.flux : lit des flux RSS / Atom (l'un après l'autre, comme les widgets de départ) et les fusionne.
// Chaque article : { titre, url, date, resume, source } où `source` est l'hôte de son URL ; sans titre ou url, écarté.

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
        // Comme aujourd'hui : au journal global (stderr) et à celui du bloc.
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
