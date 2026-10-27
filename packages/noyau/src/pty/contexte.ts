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

/** Texte pré-rempli pour l'agent d'une application, jamais envoyé. */
export function prefixeApplication(a: { nom: string; dossier: string; sansFiche: boolean; enMarche?: boolean }): string {
  // Un dossier « Sans fiche » peut porter n'importe quel nom, caractères de contrôle compris.
  const dossier = nettoyer(a.dossier);
  // Fenêtre ouverte : l'agent sait qu'il peut y brancher les outils de développement.
  const fenetre = a.enMarche ? ` — fenêtre : onglet app:${dossier} (outils de développement disponibles)` : "";
  if (a.sansFiche) return `[projet sans fiche webaios.json : /workspace/projets/${dossier}${fenetre}] `;
  const nom = tronquer(nettoyer(a.nom), LONGUEUR_TITRE);
  return `[application : ${nom} — /workspace/projets/${dossier} — journal : /workspace/.webaios/journaux/${dossier}.log${fenetre}] `;
}
