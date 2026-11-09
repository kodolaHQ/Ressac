/** Favicon at most, in bytes: it is kept in applications.json. */
export const TAILLE_FAVICON = 64 * 1024;

export function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}
