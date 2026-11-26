import type { PageLink, Zone } from "./bridge.js";

const ZONE_RANK: Record<Zone, number> = { main: 0, other: 1, aside: 2, header: 3, nav: 4, footer: 5, lang: 6 };

/** Engine result redirects: host pattern, path, parameters that may hold the target (the first web address wins). */
const REDIRECTS: [RegExp, string, string[]][] = [
  [/^(.+\.)?duckduckgo\.com$/, "/l/", ["uddg"]],
  // Google's own search domains only: a looser `google.<x>.<y>` pattern matches registrable domains anyone can buy.
  // Google's current results put the target in `url=`, with `q=` empty or absent.
  [/^(www\.)?google\.(?:com|ad|ae|al|am|as|at|az|ba|be|bf|bg|bi|bj|bs|by|ca|cat|cd|cf|cg|ch|ci|cl|cm|cn|co\.bw|co\.ck|co\.cr|co\.id|co\.il|co\.in|co\.jp|co\.ke|co\.kr|co\.ls|co\.ma|co\.mz|co\.nz|co\.th|co\.tz|co\.ug|co\.uk|co\.uz|co\.ve|co\.vi|co\.za|co\.zm|co\.zw|com\.af|com\.ag|com\.ai|com\.ar|com\.au|com\.bd|com\.bh|com\.bn|com\.bo|com\.br|com\.by|com\.bz|com\.co|com\.cu|com\.cy|com\.do|com\.ec|com\.eg|com\.et|com\.fj|com\.gh|com\.gi|com\.gt|com\.hk|com\.jm|com\.kh|com\.kw|com\.lb|com\.ly|com\.mm|com\.mt|com\.mx|com\.my|com\.na|com\.ng|com\.ni|com\.np|com\.om|com\.pa|com\.pe|com\.pg|com\.ph|com\.pk|com\.pr|com\.py|com\.qa|com\.sa|com\.sb|com\.sg|com\.sl|com\.sv|com\.tj|com\.tr|com\.tw|com\.ua|com\.uy|com\.vc|com\.vn|cv|cz|de|dj|dk|dm|dz|ee|es|fi|fm|fr|ga|ge|gg|gl|gm|gr|gy|hn|hr|ht|hu|ie|im|iq|is|it|je|jo|kg|ki|kz|la|li|lk|lt|lu|lv|md|me|mg|mk|ml|mn|ms|mu|mv|mw|ne|nl|no|nr|nu|pl|pn|ps|pt|ro|rs|ru|rw|sc|se|sh|si|sk|sm|sn|so|sr|st|td|tg|tk|tl|tm|tn|to|tt|vg|vu|ws)$/, "/url", ["q", "url"]],
];

/**
 * Click and campaign trackers a page or an engine adds to a link (Google's `srsltid` on its results, `utm_*`…): opaque
 * tokens of the page read, never the user's, that the masking would take for identifiers and the next site would receive.
 */
const TRACKING = /^(utm_[a-z_]+|srsltid|gclid|gclsrc|dclid|gbraid|wbraid|fbclid|msclkid|yclid|twclid|ttclid|igshid|mc_cid|mc_eid|_gl|li_fat_id)$/i;

/** An address without its tracking parameters (TRACKING); unchanged when it has none or does not parse. */
export function withoutTracking(url: string): string {
  try {
    const u = new URL(url);
    const keys = [...new Set(u.searchParams.keys())].filter((k) => TRACKING.test(k));
    if (!keys.length) return url;
    for (const k of keys) u.searchParams.delete(k);
    return u.href;
  } catch {
    return url;
  }
}

/**
 * The address a link means: an engine's result redirect unwrapped (DuckDuckGo `/l/?uddg=`, Google `/url?q=`), and its
 * tracking parameters dropped; any other address unchanged.
 */
export function unwrapLink(url: string): string {
  try {
    const u = new URL(url);
    for (const [host, path, params] of REDIRECTS) {
      if (!host.test(u.hostname) || u.pathname !== path) continue;
      const target = params.map((p) => u.searchParams.get(p) ?? "").find((t) => URL.canParse(t) && /^https?:$/.test(new URL(t).protocol));
      return target ? withoutTracking(target) : url;
    }
  } catch {}
  return withoutTracking(url);
}

export const withoutHash = (url: string) => {
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
  const self = withoutHash(unwrapLink(pageUrl));
  const best = new Map<string, PageLink & { rank: number; order: number }>();
  links.forEach((l, order) => {
    const text = l.text.trim();
    const url = withoutHash(unwrapLink(l.url));
    if (!text || url === self) return;
    const zone = l.zone ?? "other";
    const rank = ZONE_RANK[zone] ?? ZONE_RANK.other;
    const had = best.get(url);
    // A card often links twice (photo, then title): the photo of either is kept.
    const image = l.image ?? had?.image;
    if (!had || rank < had.rank) best.set(url, { text, url, zone, ...(image ? { image } : {}), rank, order: had ? Math.min(had.order, order) : order });
    else if (image && !had.image) had.image = image;
  });
  return [...best.values()].sort((a, b) => a.rank - b.rank || a.order - b.order).map(({ text, url, zone, image }) => ({ text, url, zone, ...(image ? { image } : {}) }));
}
