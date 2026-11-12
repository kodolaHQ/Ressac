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
  "open-app": "ouvrir un lien dans une autre application",
  "read-tab": "lire un onglet",
  "devtools": "utiliser les outils de développement",
  "widget-data": "voir les données d'un widget",
  extension: "activer une extension",
  "extension-console": "voir toute la console d'une extension",
  "agent-address": "ouvrir une adresse écrite par l'agent",
  other: "une permission inconnue",
  "screen-share": "partager votre écran",
  drm: "lire des contenus protégés (DRM)",
  midi: "utiliser vos appareils MIDI",
};

/** The banner's sentence: « <site> veut utiliser votre caméra et votre micro », the link cut at 120. */
export function bannerText(d: { origin: string; permissions: readonly SitePermission[]; link?: string }): string {
  const media = d.permissions.filter((p) => p.startsWith("media-")).map((p) => NAMES[p]);
  const others = d.permissions.filter((p) => !p.startsWith("media-")).map((p) => NAMES[p]);
  const parts = [...(media.length ? [`utiliser ${media.join(" et ")}`] : []), ...others];
  // Never throws: an unreadable origin (about:blank, data:…) is shown as it is.
  const text = `${siteOf(d.origin)} veut ${parts.join(" et ")}`;
  return d.link ? `${text} : ${d.link.slice(0, 120)}` : text;
}
