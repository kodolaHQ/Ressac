/** Favicon au plus, en octets : il est gardé dans applications.json. */
export const TAILLE_FAVICON = 64 * 1024;

type Chercher = (url: string, init: { signal: AbortSignal }) => Promise<Response>;

/**
 * Le favicon d'une appli en adresse `data:` (son port ne servira plus rien une fois l'appli arrêtée) ; undefined en cas
 * d'échec. L'appli n'est pas sûre (un POC exécute le code d'un package) : seule son origine est lue, jamais un fichier
 * local, et la lecture s'arrête dès que la taille dépasse la borne, avant de tout garder en mémoire.
 */
export async function faviconEnDonnees(chercher: Chercher, url: string, page: string): Promise<string | undefined> {
  if (url.startsWith("data:")) return url.length <= TAILLE_FAVICON ? url : undefined;
  if (!/^https?:\/\//.test(url) || !memeOrigine(url, page)) return undefined;
  const arret = new AbortController();
  const minuterie = setTimeout(() => arret.abort(), 5000);
  try {
    const r = await chercher(url, { signal: arret.signal });
    const type = r.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
    if (!r.ok || !type.startsWith("image/") || !r.body || Number(r.headers.get("content-length") ?? 0) > TAILLE_FAVICON) return undefined;
    const morceaux: Uint8Array[] = [];
    let taille = 0;
    const lecteur = r.body.getReader();
    for (;;) {
      const { done, value } = await lecteur.read();
      if (done) break;
      taille += value.length;
      if (taille > TAILLE_FAVICON) {
        arret.abort();
        await lecteur.cancel().catch(() => {});
        return undefined;
      }
      morceaux.push(value);
    }
    return `data:${type};base64,${Buffer.concat(morceaux).toString("base64")}`;
  } catch {
    return undefined;
  } finally {
    clearTimeout(minuterie);
  }
}

export function memeOrigine(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}
