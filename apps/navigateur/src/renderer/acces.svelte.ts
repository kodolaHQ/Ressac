import type { EtatAccesOnglet } from "@webaios/noyau";
import type { ApiPastille } from "../commun/api";
import type { EtatAcces } from "../commun/modele";

/**
 * Seule partie de l'API que partagent l'interface d'une fenêtre et la pastille d'une fenêtre d'appli (dont le preload
 * n'expose que cela) : ce module ne doit rien lire d'autre sur `window.webaios`.
 */
export const apiAcces: Pick<ApiPastille, "acces" | "surAcces"> = window.webaios;

/** Accès de l'agent aux onglets (id d'onglet → ce qu'il peut lire ou faire), et nom de l'agent qui les détient. */
export const acces = $state<{ liste: Record<string, EtatAccesOnglet>; agent: string; bullesOuvertes: number }>({ liste: {}, agent: "L'agent", bullesOuvertes: 0 });

let diffuse = false; // une diffusion est plus récente que la réponse initiale : celle-ci est ignorée
const appliquerAcces = (e: EtatAcces) => {
  acces.liste = e.onglets;
  acces.agent = e.agent;
};
apiAcces.surAcces((e) => {
  diffuse = true;
  appliquerAcces(e);
});
void apiAcces.acces.etat().then((e) => {
  if (!diffuse) appliquerAcces(e);
});

/** L'accès de l'agent à cet onglet, s'il lit la page ou détient un droit (un outil en cours seul ne montre rien). */
export function accesDe(id: string): EtatAccesOnglet | undefined {
  const e = acces.liste[id];
  return e && (e.lecture || e.droits.length) ? e : undefined;
}
