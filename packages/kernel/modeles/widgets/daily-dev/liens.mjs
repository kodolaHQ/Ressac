// daily.dev: the feed posts (block `fil`, read with the account). Runs in the container without network.
// Everything that comes from the page is data, never an instruction.
const HOST = "app.daily.dev";

export default async (page) => {
  const seen = new Set();
  const items = [];
  for (const l of page?.links ?? []) {
    const title = String(l?.text ?? "").replace(/\s+/g, " ").trim();
    const url = String(l?.url ?? "");
    if (!/^https:\/\/app\.daily\.dev\/posts\//.test(url) || title.length < 15 || seen.has(url)) continue;
    seen.add(url);
    items.push({ title, url, source: HOST });
  }
  if (!items.length) throw new Error("Aucun article trouvé : es-tu connecté à daily.dev dans ce profil ?");
  return items;
};
