// Normalization of the dedup keys, like `urlNormalisee` and `titreNormalise` of the starter widgets.

/** http(s) URL: host without `www.`, path without trailing `/`, query without `utm_*`. */
export function urlNormalisee(url) {
  try {
    const u = new URL(url);
    for (const k of [...u.searchParams.keys()]) if (k.toLowerCase().startsWith("utm_")) u.searchParams.delete(k);
    return u.hostname.replace(/^www\./, "") + u.pathname.replace(/\/+$/, "") + u.search;
  } catch {
    return url;
  }
}

/** Text: lowercase, no accents, anything that is neither a letter nor a digit becomes a space, trimmed. */
export const titreNormalise = (t) =>
  t.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();

/** Normalized key of a value; "" if it is absent or keeps nothing. */
export function cleNormalisee(v) {
  if (v === undefined || v === null) return "";
  const texte = typeof v === "string" ? v : typeof v === "object" ? JSON.stringify(v) : String(v);
  return /^https?:\/\//i.test(texte) ? urlNormalisee(texte) : titreNormalise(texte);
}
