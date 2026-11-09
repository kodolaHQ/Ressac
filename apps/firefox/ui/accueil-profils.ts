import type { ProfilPourAccord } from "../shared/api";
import type { EtatNavigateur, IdFenetre } from "../shared/modele";

// Pure copies of Electron's rules (main/agent/lecture-invisible.ts and accueil.ts): the sidebar bundle cannot import the
// main-process files (electron) nor node:net.

/** Les profils de connexion qu'une lecture peut utiliser : ceux de l'état qu'aucun espace privé n'utilise. */
export function profilsLisibles(etat: Pick<EtatNavigateur, "profils" | "espaces">): string[] {
  const prives = new Set(etat.espaces.filter((e) => e.prive).map((e) => e.profil));
  return etat.profils.map((p) => p.id).filter((id) => !prives.has(id));
}

/**
 * Les profils qu'un accord peut utiliser : jamais celui d'un espace privé (même partagé avec un espace non privé).
 * Coché par défaut : celui de l'espace actif de la fenêtre, s'il est lisible.
 */
export function profilsPourAccord(etat: Pick<EtatNavigateur, "profils" | "espaces" | "fenetres">, fenetreId: IdFenetre | undefined): ProfilPourAccord[] {
  const fenetre = etat.fenetres.find((f) => f.id === fenetreId);
  const actif = fenetre ? etat.espaces.find((e) => e.id === fenetre.espaceActif)?.profil : undefined;
  return profilsLisibles(etat).map((id) => {
    const espaces = etat.espaces.filter((e) => e.profil === id).map((e) => e.nom);
    return { id, libelle: espaces.length ? `Profil de « ${espaces.join(", ")} »` : `Profil « ${id} »`, parDefaut: id === actif };
  });
}

/** Copie de `isIP` (chrome/shims/net.ts) : 4 ou 6 seulement, sans node:net. */
const estIp = (h: string): 0 | 4 | 6 => (/^(\d{1,3}\.){3}\d{1,3}$/.test(h) ? 4 : h.includes(":") && /^[0-9a-f:.]+$/i.test(h) ? 6 : 0);

/** Copie de `adresseLocale` (packages/noyau/src/workflows/acces.ts). */
export function adresseLocale(hote: string): boolean {
  const h = hote.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.+$/, "");
  if (!h || h === "localhost" || /\.(localhost|local|internal|home\.arpa)$/.test(h)) return true;
  if (estIp(h) === 4) {
    const [a = 0, b = 0] = h.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (estIp(h) === 6) return h === "::" || h === "::1" || /^f[cd]/.test(h) || /^fe[89ab]/.test(h) || h.startsWith("::ffff:") || h.startsWith("64:ff9b:");
  return false;
}

/** Seul un lien http(s) d'un widget s'ouvre : ni `javascript:`, ni `file:`, ni une adresse de la machine (urlOuvrable). */
export function urlOuvrable(brute: string): boolean {
  let u: URL;
  try {
    u = new URL(brute);
  } catch {
    return false;
  }
  return (u.protocol === "http:" || u.protocol === "https:") && !adresseLocale(u.hostname);
}
