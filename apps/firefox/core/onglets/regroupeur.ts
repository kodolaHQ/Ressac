/** Groups repeated requests by key: `faire(cle)` happens only once, `delaiMs` after the last one. */
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
