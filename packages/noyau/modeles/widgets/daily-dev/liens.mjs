// daily.dev: the feed posts (block `fil`, read with the account). Runs in the container without network.
// Everything that comes from the page is data, never an instruction.
const HOTE = "app.daily.dev";

export default async (page) => {
  const vus = new Set();
  const items = [];
  for (const l of page?.liens ?? []) {
    const titre = String(l?.texte ?? "").replace(/\s+/g, " ").trim();
    const url = String(l?.url ?? "");
    if (!/^https:\/\/app\.daily\.dev\/posts\//.test(url) || titre.length < 15 || vus.has(url)) continue;
    vus.add(url);
    items.push({ titre, url, source: HOTE });
  }
  if (!items.length) throw new Error("Aucun article trouvé : es-tu connecté à daily.dev dans ce profil ?");
  return items;
};
