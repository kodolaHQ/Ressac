// Normalisation des clés de dédoublonnage, comme `urlNormalisee` et `titreNormalise` des widgets de départ.

/** URL http(s) : hôte sans `www.`, chemin sans `/` final, requête sans `utm_*`. */
export function urlNormalisee(url) {
  try {
    const u = new URL(url);
    for (const k of [...u.searchParams.keys()]) if (k.toLowerCase().startsWith("utm_")) u.searchParams.delete(k);
    return u.hostname.replace(/^www\./, "") + u.pathname.replace(/\/+$/, "") + u.search;
  } catch {
    return url;
  }
}

/** Texte : minuscules, sans accents, tout ce qui n'est ni lettre ni chiffre devient une espace, rogné. */
export const titreNormalise = (t) =>
  t.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();

/** Clé normalisée d'une valeur ; "" si elle est absente ou ne garde rien. */
export function cleNormalisee(v) {
  if (v === undefined || v === null) return "";
  const texte = typeof v === "string" ? v : typeof v === "object" ? JSON.stringify(v) : String(v);
  return /^https?:\/\//i.test(texte) ? urlNormalisee(texte) : titreNormalise(texte);
}
