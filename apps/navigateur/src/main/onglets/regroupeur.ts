/** Regroupe les demandes répétées par clé : `faire(cle)` n'a lieu qu'une fois, `delaiMs` après la dernière. */
export function creerRegroupeur(delaiMs: number, faire: (cle: string) => void) {
  const minuteurs = new Map<string, ReturnType<typeof setTimeout>>();
  return {
    planifier(cle: string): void {
      clearTimeout(minuteurs.get(cle));
      minuteurs.set(
        cle,
        setTimeout(() => {
          minuteurs.delete(cle);
          faire(cle);
        }, delaiMs),
      );
    },
    oublier(cle: string): void {
      clearTimeout(minuteurs.get(cle));
      minuteurs.delete(cle);
    },
  };
}
