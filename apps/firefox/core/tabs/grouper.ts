/** Groups repeated requests by key: `faire(cle)` happens only once, `delaiMs` after the last one. */
export function createGrouper(delayMs: number, make: (key: string) => void) {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  return {
    planifier(key: string): void {
      clearTimeout(timers.get(key));
      timers.set(
        key,
        setTimeout(() => {
          timers.delete(key);
          make(key);
        }, delayMs),
      );
    },
    oublier(key: string): void {
      clearTimeout(timers.get(key));
      timers.delete(key);
    },
  };
}
