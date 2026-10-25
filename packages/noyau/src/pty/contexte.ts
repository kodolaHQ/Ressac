const LONGUEUR_TITRE = 120;

/** Remplace les caractères de contrôle par une espace : un \r taperait Entrée à la place de l'utilisateur. */
function nettoyer(texte: string): string {
  return texte.replace(/[\x00-\x1f\x7f]/g, " ").replace(/ {2,}/g, " ").trim();
}

/** Texte pré-rempli dans le terminal de l'agent, jamais envoyé : `[contexte : <titre> — <url>] `. */
export function prefixeContexte(titre: string, url: string): string {
  let t = nettoyer(titre);
  if (t.length > LONGUEUR_TITRE) t = `${t.slice(0, LONGUEUR_TITRE)}…`;
  const u = nettoyer(url);
  return t ? `[contexte : ${t} — ${u}] ` : `[contexte : ${u}] `;
}
