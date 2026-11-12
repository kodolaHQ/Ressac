/** Bookmarks live in Firefox Places (global, never per space): http(s) only, one row per URL. */
export async function searchBookmarks(text: string, limit = 20): Promise<{ url: string; title: string }[]> {
  const { PlacesUtils } = ChromeUtils.importESModule("resource://gre/modules/PlacesUtils.sys.mjs");
  const q = String(text).trim();
  if (!q) return [];
  const seen = new Set<string>();
  const out: { url: string; title: string }[] = [];
  for (const b of await PlacesUtils.bookmarks.search({ query: q })) {
    const url: string = b.url?.href ?? "";
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
    seen.add(url);
    out.push({ url, title: b.title ?? "" });
    if (out.length >= limit) break;
  }
  return out;
}
