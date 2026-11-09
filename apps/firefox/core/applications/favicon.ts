/** Favicon au plus, en octets : il est gardé dans applications.json. */
export const TAILLE_FAVICON = 64 * 1024;

export function memeOrigine(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}
