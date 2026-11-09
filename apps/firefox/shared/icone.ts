/** Scheme the UI (no network) uses for http(s) favicons. Nothing serves it in Firefox: such an icon fails to load. */
export const SCHEMA_ICONE = "webaios-icone";

/** L'adresse qu'utilise l'interface pour afficher le favicon `url` : http(s) passe par `webaios-icone:`, data: reste. */
export function urlIcone(url: string): string | null {
  if (/^data:image\//i.test(url)) return url;
  if (!/^https?:\/\//i.test(url)) return null;
  return `${SCHEMA_ICONE}://site/?u=${encodeURIComponent(url)}`;
}
