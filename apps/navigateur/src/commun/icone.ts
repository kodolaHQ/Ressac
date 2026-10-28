/** Schéma par lequel l'interface (sans réseau) affiche les favicons des sites : main/reseau-interface.ts les cherche. */
export const SCHEMA_ICONE = "webaios-icone";

/** L'adresse qu'utilise l'interface pour afficher le favicon `url` : http(s) passe par `webaios-icone:`, data: reste. */
export function urlIcone(url: string): string | null {
  if (/^data:image\//i.test(url)) return url;
  if (!/^https?:\/\//i.test(url)) return null;
  return `${SCHEMA_ICONE}://site/?u=${encodeURIComponent(url)}`;
}
