// Reading RSS 2.0 and Atom feeds with regular expressions, no dependency.
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", eacute: "é", egrave: "è", agrave: "à", ecirc: "ê", ccedil: "ç", rsquo: "’", lsquo: "‘", hellip: "…", ndash: "–", mdash: "—" };
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e) => {
    if (e[0] === "#") {
      const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(code); } catch { return all; }
    }
    return ENTITIES[e.toLowerCase()] ?? all;
  });
}
function tagText(block, name) {
  const m = new RegExp(`<${name}(?:\\s[^<>]*)?>((?:(?!<${name}[\\s>])[\\s\\S])*?)</${name}>`, "i").exec(block);
  if (!m) return "";
  const inner = m[1].trim();
  const cdata = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(inner);
  return (cdata ? cdata[1] : decodeEntities(inner)).trim();
}
function blockLink(block) {
  const links = [...block.matchAll(/<link\b([^<>]*?)\/?>/gi)];
  for (const [, attrs] of links) {
    const href = /href\s*=\s*["']([^"']+)["']/i.exec(attrs);
    const rel = /rel\s*=\s*["']([^"']+)["']/i.exec(attrs);
    if (href && (!rel || rel[1] === "alternate")) return decodeEntities(href[1]);
  }
  return tagText(block, "link");
}
export function parseFeed(xml) {
  // A body stops at the next opening tag: unclosed ones (`<item>x` × 20 000) made the scan quadratic.
  const blocks = [...xml.matchAll(/<(item|entry)\b[^<>]*>((?:(?!<(?:item|entry)\b)[\s\S])*?)<\/\1>/gi)].map((m) => m[2]);
  return blocks.map((b) => ({
    title: tagText(b, "title"),
    url: blockLink(b),
    date: tagText(b, "pubDate") || tagText(b, "updated") || tagText(b, "published") || tagText(b, "dc:date"),
    summary: tagText(b, "description") || tagText(b, "summary") || tagText(b, "content"),
  }));
}
