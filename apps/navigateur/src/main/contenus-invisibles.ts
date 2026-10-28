import type { WebContents } from "electron";

/**
 * Pages lues en invisible pour les widgets (voir agent/lecture-invisible.ts). Une telle page peut partager la session
 * d'un profil de connexion avec les onglets de l'utilisateur : les gestionnaires de cette session (autorisations,
 * téléchargements) la reconnaissent ici et lui refusent tout, sans rien changer pour les vrais onglets.
 */
const invisibles = new WeakSet<WebContents>();

export function marquerInvisible(wc: WebContents): void {
  invisibles.add(wc);
}

export function estInvisible(wc: WebContents | null | undefined): boolean {
  return !!wc && invisibles.has(wc);
}
