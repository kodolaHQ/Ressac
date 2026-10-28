/** Délai entre l'appui réel de la souris dans un widget et la demande de lien qu'il permet (appui long compris). */
export const DELAI_GESTE_MS = 1500;

/** Le cadre (iframe) du widget dans la page de l'interface, en pixels CSS. */
export interface CadreWidget {
  x: number;
  y: number;
  largeur: number;
  hauteur: number;
}

/**
 * Un widget n'ouvre un lien que juste après un vrai clic de l'utilisateur dans son cadre. Le clic est vu par le process
 * principal (`input-event` de l'interface), que le code d'un widget ne peut pas produire : ni focus forcé, ni événement
 * synthétique. Un clic permet un seul lien ; une demande d'un autre cadre ne l'use pas.
 */
export function gardienGestes<F>(maintenant: () => number = () => Date.now()) {
  const derniers = new Map<F, { t: number; x: number; y: number }>();
  return {
    /** Appui réel de la souris dans l'interface de la fenêtre, en pixels CSS de la page. */
    clic(fenetre: F, x: number, y: number) {
      derniers.set(fenetre, { t: maintenant(), x, y });
    },
    /** Demande de lien du widget affiché dans `cadre` : acceptée (et le clic consommé) si un clic récent y est tombé. */
    accepter(fenetre: F, cadre: CadreWidget): boolean {
      const c = derniers.get(fenetre);
      if (!c || maintenant() - c.t > DELAI_GESTE_MS) return false;
      const dedans = c.x >= cadre.x && c.x < cadre.x + cadre.largeur && c.y >= cadre.y && c.y < cadre.y + cadre.hauteur;
      if (!dedans) return false;
      derniers.delete(fenetre);
      return true;
    },
  };
}
