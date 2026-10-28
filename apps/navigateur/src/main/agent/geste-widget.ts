/** Délai entre l'appui réel de l'utilisateur dans un widget et la demande de lien qu'il permet (appui long compris). */
export const DELAI_GESTE_MS = 1500;

/**
 * Un widget n'ouvre un lien que juste après un vrai clic de l'utilisateur dans son affichage. Le clic est vu dans le cadre du
 * widget par le preload (monde isolé, `isTrusted`), que le code du widget ne peut ni lire ni imiter (ni focus forcé, ni
 * événement synthétique), puis signalé au process principal, qui sait de quel cadre il vient (`senderFrame`). Seul le
 * dernier geste de chaque fenêtre compte ; il permet un seul lien, au seul widget où il a eu lieu.
 */
export function gardienGestes<F>(maintenant: () => number = () => Date.now()) {
  const derniers = new Map<F, { t: number; widget: string }>();
  return {
    /** Appui réel de la souris dans l'affichage du widget `widget` de cette fenêtre. */
    geste(fenetre: F, widget: string) {
      derniers.set(fenetre, { t: maintenant(), widget });
    },
    /** Demande de lien du widget `widget` : acceptée (et le geste consommé) si son dernier geste est récent et à lui. */
    accepter(fenetre: F, widget: string): boolean {
      const g = derniers.get(fenetre);
      if (!g || g.widget !== widget || maintenant() - g.t > DELAI_GESTE_MS) return false;
      derniers.delete(fenetre);
      return true;
    },
  };
}
