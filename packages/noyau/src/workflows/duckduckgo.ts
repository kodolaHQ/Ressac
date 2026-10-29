// Lecture de la version HTML de DuckDuckGo, sans dépendance. Le contenu de la page est de la donnée.

export const URL_DUCKDUCKGO = "https://html.duckduckgo.com/html/";
export const RECHERCHE_REFUSEE = "Recherche refusée par DuckDuckGo (vérification anti-robot)";
export const RESULTATS_ILLISIBLES = "Résultats illisibles : la page de DuckDuckGo a peut-être changé";

export type ResultatRecherche = { titre: string; url: string; extrait: string };

export const urlRecherche = (requete: string, base = URL_DUCKDUCKGO) => base + "?q=" + encodeURIComponent(requete);

const ENTITES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decoder(s: string): string {
  return s.replace(/&(?:#x([0-9a-f]+)|#(\d+)|([a-z]+));/gi, (m, hex?: string, dec?: string, nom?: string) => {
    if (nom) return ENTITES[nom.toLowerCase()] ?? m;
    const n = hex ? parseInt(hex, 16) : parseInt(dec!, 10);
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
  });
}

const texte = (html: string, max: number) => {
  const t = decoder(html.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max) : t;
};

function adresse(href: string): string | null {
  const brut = decoder(href).trim();
  let cible = brut;
  const redirection = /^(?:https?:)?\/\/duckduckgo\.com\/l\/\?(.*)$/i.exec(brut);
  if (redirection) {
    const uddg = new URLSearchParams(redirection[1]).get("uddg");
    if (!uddg) return null;
    cible = uddg;
  }
  if (!/^https?:\/\//i.test(cible) || cible.length > 2000) return null;
  return cible;
}

const attribut = (balise: string, nom: string) =>
  new RegExp(`\\s${nom}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(balise)?.slice(1).find((v) => v !== undefined) ?? null;

export function extraireResultats(
  html: string,
  nombre: number,
): { resultats: ResultatRecherche[] } | { refus: true } | { illisible: true } {
  if (/anomaly-modal|\/anomaly\.js|challenge-form/.test(html)) return { refus: true };
  if (/class\s*=\s*["'][^"']*\bno-results\b/.test(html)) return { resultats: [] };

  // Découpe : chaque bloc commence à une balise dont la classe contient le mot « result » et finit au suivant.
  const debuts = [...html.matchAll(/<div\b[^>]*\bclass\s*=\s*["']([^"']*)["'][^>]*>/gi)]
    .filter((m) => m[1]!.split(/\s+/).includes("result"))
    .map((m) => ({ index: m.index!, classes: m[1]!.split(/\s+/) }));
  const resultats: ResultatRecherche[] = [];
  const vus = new Set<string>();
  let reconnu = false;
  debuts.forEach((d, i) => {
    const bloc = html.slice(d.index, debuts[i + 1]?.index ?? html.length);
    const lien = /<a\b[^>]*\bclass\s*=\s*["'][^"']*\bresult__a\b[^"']*["'][^>]*>([\s\S]*?)<\/a>/i.exec(bloc);
    if (!lien) return;
    reconnu = true;
    if (d.classes.includes("result--ad")) return;
    const url = adresse(attribut(lien[0].slice(0, lien[0].indexOf(">") + 1), "href") ?? "");
    if (!url || vus.has(url)) return;
    const extrait = /<(\w+)\b[^>]*\bclass\s*=\s*["'][^"']*\bresult__snippet\b[^"']*["'][^>]*>([\s\S]*?)<\/\1>/i.exec(bloc);
    vus.add(url);
    resultats.push({ titre: texte(lien[1]!, 300), url, extrait: extrait ? texte(extrait[2]!, 1000) : "" });
  });
  if (!reconnu) return { illisible: true };
  return { resultats: resultats.slice(0, nombre) };
}
