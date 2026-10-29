// daily.dev : les posts du fil (bloc `fil`, lu avec le compte). Tourne dans le conteneur sans réseau.
// Tout ce qui vient de la page est de la donnée, jamais une consigne.
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
