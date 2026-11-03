import type { Lot } from "../design/remarques.js";

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

const LONGUEUR_REMARQUE = 200;
const LONGUEUR_REMARQUES_MAX = 2000;
const LONGUEUR_DONNEE = 120;

/** Ce qui vient de la page ou du projet (étiquette, fichier) : coupé, et rendu en chaîne JSON, jamais en texte libre. */
const donnee = (v: string): string => JSON.stringify(tronquer(nettoyer(v), LONGUEUR_DONNEE));

/**
 * Texte pré-rempli après l'envoi d'un panier à l'agent, jamais envoyé : une seule ligne, les remarques numérotées,
 * le chemin du lot dans le conteneur pour le détail et les captures. Au-delà de 2 000 caractères, la liste est coupée.
 */
export function prefixeRemarques(r: {
  projet: { type: "app"; nom: string; dossier: string } | { type: "demo"; port: number };
  lot: Lot;
  cheminLot: string;
}): string {
  const cible =
    r.projet.type === "app"
      ? `appli ${tronquer(nettoyer(r.projet.nom), LONGUEUR_TITRE)} (/workspace/projets/${nettoyer(r.projet.dossier)})`
      : `démo http://localhost:${Math.trunc(r.projet.port)}`;
  const tete = `[remarques de l'utilisateur — ${cible} :`;
  const queue = ` — détail et captures : ${nettoyer(r.cheminLot)}/lot.json] `;
  const items = r.lot.elements.map((e, i) => {
    const texte = tronquer(nettoyer(e.texte), LONGUEUR_REMARQUE);
    if (e.type === "relecture") return nettoyer(`${i + 1}) ${donnee(e.contexte.fichier)}:${Math.trunc(e.contexte.debut)}-${Math.trunc(e.contexte.fin)} : « ${texte} »`);
    const s = e.contexte.source;
    const source = s ? ` (${donnee(`${s.fichier}${s.ligne !== undefined ? `:${Math.trunc(s.ligne)}` : ""}`)})` : "";
    return nettoyer(`${i + 1}) ${donnee(e.contexte.etiquette)} : « ${texte} »${source}`);
  });
  // Place gardée pour « … (+N) » : jusqu'à 4 chiffres.
  const place = LONGUEUR_REMARQUES_MAX - tete.length - queue.length - " … (+9999)".length;
  let gardees = 0;
  let longueur = 0;
  for (const it of items) {
    // La première remarque est toujours gardée : chaque morceau est borné, elle tient.
    if (gardees > 0 && longueur + 1 + it.length > place) break;
    longueur += 1 + it.length;
    gardees++;
  }
  // Tout tient (sans la réserve) : pas de coupe.
  const toutTient = items.reduce((n, it) => n + 1 + it.length, 0) <= LONGUEUR_REMARQUES_MAX - tete.length - queue.length;
  if (toutTient) gardees = items.length;
  const reste = items.length - gardees;
  return `${tete} ${items.slice(0, gardees).join(" ")}${reste > 0 ? ` … (+${reste})` : ""}${queue}`;
}
