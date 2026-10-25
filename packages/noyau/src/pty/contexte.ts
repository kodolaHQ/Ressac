const LONGUEUR_TITRE = 120;
const LONGUEUR_URL = 300;

/**
 * Remplace les caractères de contrôle (C0, DEL, C1 dont le CSI 8 bits) et les séparateurs de ligne
 * Unicode par une espace : un \r taperait Entrée à la place de l'utilisateur.
 */
function nettoyer(texte: string): string {
  return texte.replace(/[\p{Cc}\u2028\u2029]/gu, " ").replace(/ {2,}/g, " ").trim();
}

const tronquer = (texte: string, max: number) => (texte.length > max ? `${texte.slice(0, max)}…` : texte);

/** Texte pré-rempli dans le terminal de l'agent, jamais envoyé : `[contexte : <titre> — <url>] `. */
export function prefixeContexte(titre: string, url: string): string {
  const t = tronquer(nettoyer(titre), LONGUEUR_TITRE);
  const u = tronquer(nettoyer(url), LONGUEUR_URL);
  return t ? `[contexte : ${t} — ${u}] ` : `[contexte : ${u}] `;
}
