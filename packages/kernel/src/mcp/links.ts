import type { PageLink, Zone } from "./bridge.js";

const ZONE_RANK: Record<Zone, number> = { main: 0, other: 1, aside: 2, header: 3, nav: 4, footer: 5, lang: 6 };

/** Engine result redirects: host pattern, path, parameter holding the target. */
const REDIRECTS: [RegExp, string, string][] = [
  [/^(.+\.)?duckduckgo\.com$/, "/l/", "uddg"],
  [/^(www\.)?google\.[a-z]{2,3}(\.[a-z]{2})?$/, "/url", "q"],
];

/** The target of an engine's result redirect (DuckDuckGo `/l/?uddg=`, Google `/url?q=`); any other address unchanged. */
export function unwrapLink(url: string): string {
  try {
    const u = new URL(url);
    for (const [host, path, param] of REDIRECTS) {
      if (!host.test(u.hostname) || u.pathname !== path) continue;
      const target = u.searchParams.get(param) ?? "";
      return URL.canParse(target) && /^https?:$/.test(new URL(target).protocol) ? target : url;
    }
  } catch {}
  return url;
}

const withoutHash = (url: string) => {
  try {
    const u = new URL(url);
    u.hash = "";
    return u.href;
  } catch {
    return url;
  }
};

/**
 * The page's links as the agent should see them: redirects unwrapped, one per address (fragment dropped) at its best
 * zone, the page itself and links without text dropped, main content first then by zone, document order within a zone.
 */
export function rankLinks(links: readonly PageLink[], pageUrl: string): PageLink[] {
  const self = withoutHash(pageUrl);
  const best = new Map<string, PageLink & { rank: number; order: number }>();
  links.forEach((l, order) => {
    const text = l.text.trim();
    const url = withoutHash(unwrapLink(l.url));
    if (!text || url === self) return;
    const zone = l.zone ?? "other";
    const rank = ZONE_RANK[zone] ?? ZONE_RANK.other;
    const had = best.get(url);
    if (!had || rank < had.rank) best.set(url, { text, url, zone, rank, order: had ? Math.min(had.order, order) : order });
  });
  return [...best.values()].sort((a, b) => a.rank - b.rank || a.order - b.order).map(({ text, url, zone }) => ({ text, url, zone }));
}
