// source.feed: reads RSS / Atom feeds (one after the other, like the starter widgets) and merges them.
// Each article: { title, url, date, summary, source } where `source` is the host of its URL; without a title or url, it is discarded.

const message = (e) => String(e?.message ?? e);
const host = (url) => {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
};

export default {
  perItem: "no",
  async run({ params, webaios, partial }) {
    const onError = params.onError ?? "skip";
    const articles = [];
    let read = 0;
    for (const url of params.urls) {
      let feed;
      try {
        feed = await webaios.readFeed(url);
      } catch (e) {
        if (onError === "fail") throw new Error(`Flux en échec : ${url} : ${message(e)}`);
        // As today: to the global log (stderr) and to the block's log.
        webaios.log("source en échec :", url, message(e));
        partial();
        continue;
      }
      read++;
      for (const it of feed) {
        if (!it.title || !it.url) continue;
        articles.push({ title: it.title, url: it.url, date: it.date ?? "", summary: it.summary ?? "", source: host(it.url) });
      }
    }
    if (read === 0) throw new Error("Aucun flux n'a pu être lu");
    if (!articles.length) throw new Error("Aucun article récupéré");
    return { output: articles };
  },
};
