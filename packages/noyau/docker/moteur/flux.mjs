// Lecture des flux RSS 2.0 et Atom par expressions régulières, sans dépendance.
const ENTITES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", eacute: "é", egrave: "è", agrave: "à", ecirc: "ê", ccedil: "ç", rsquo: "’", lsquo: "‘", hellip: "…", ndash: "–", mdash: "—" };
function decoderEntites(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (tout, e) => {
    if (e[0] === "#") {
      const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(code); } catch { return tout; }
    }
    return ENTITES[e.toLowerCase()] ?? tout;
  });
}
function texteBalise(bloc, nom) {
  const m = new RegExp(`<${nom}(?:\\s[^>]*)?>([\\s\\S]*?)</${nom}>`, "i").exec(bloc);
  if (!m) return "";
  const interne = m[1].trim();
  const cdata = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(interne);
  return (cdata ? cdata[1] : decoderEntites(interne)).trim();
}
function lienBloc(bloc) {
  const liens = [...bloc.matchAll(/<link\b([^>]*?)\/?>/gi)];
  for (const [, attrs] of liens) {
    const href = /href\s*=\s*["']([^"']+)["']/i.exec(attrs);
    const rel = /rel\s*=\s*["']([^"']+)["']/i.exec(attrs);
    if (href && (!rel || rel[1] === "alternate")) return decoderEntites(href[1]);
  }
  return texteBalise(bloc, "link");
}
export function analyserFlux(xml) {
  const blocs = [...xml.matchAll(/<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi)].map((m) => m[2]);
  return blocs.map((b) => ({
    titre: texteBalise(b, "title"),
    url: lienBloc(b),
    date: texteBalise(b, "pubDate") || texteBalise(b, "updated") || texteBalise(b, "published") || texteBalise(b, "dc:date"),
    resume: texteBalise(b, "description") || texteBalise(b, "summary") || texteBalise(b, "content"),
  }));
}
