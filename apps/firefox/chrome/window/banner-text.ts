import { siteOf } from "../../shared/model";
import type { SitePermission } from "../store/site-permissions";

/** The permission names the banner shows, plus the three kinds of WebAiOs-Firefox. */
const NAMES: Record<SitePermission, string> = {
  "media-camera": "votre caméra",
  "media-micro": "votre micro",
  notifications: "vous envoyer des notifications",
  geolocation: "connaître votre position",
  fullscreen: "passer en plein écran",
  "clipboard-sanitized-write": "écrire dans le presse-papiers",
  "ouvrir-application": "ouvrir un lien dans une autre application",
  "lire-onglet": "lire un onglet",
  "outils-dev": "utiliser les outils de développement",
  "donnees-widget": "voir les données d'un widget",
  extension: "activer une extension",
  "console-extension": "voir toute la console d'une extension",
  autre: "une permission inconnue",
  "partage-ecran": "partager votre écran",
  drm: "lire des contenus protégés (DRM)",
  midi: "utiliser vos appareils MIDI",
};

/** The banner's sentence: « <site> veut utiliser votre caméra et votre micro », the link cut at 120. */
export function bannerText(d: { origine: string; permissions: readonly SitePermission[]; lien?: string }): string {
  const media = d.permissions.filter((p) => p.startsWith("media-")).map((p) => NAMES[p]);
  const others = d.permissions.filter((p) => !p.startsWith("media-")).map((p) => NAMES[p]);
  const parts = [...(media.length ? [`utiliser ${media.join(" et ")}`] : []), ...others];
  // Never throws: an unreadable origin (about:blank, data:…) is shown as it is.
  const text = `${siteOf(d.origine)} veut ${parts.join(" et ")}`;
  return d.lien ? `${text} : ${d.lien.slice(0, 120)}` : text;
}
