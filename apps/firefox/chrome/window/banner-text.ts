import { format } from "../../shared/i18n";
import { siteOf } from "../../shared/model";
import type { SitePermission } from "../store/site-permissions";

/** The banner's sentence: « <site> veut utiliser votre caméra et votre micro », the link cut at 120. */
export function bannerText(d: { origin: string; permissions: readonly SitePermission[]; link?: string }, locale: string): string {
  const say = (p: SitePermission) => format(locale, `chrome-perm-${p}`);
  const list = new Intl.ListFormat(locale, { type: "conjunction", style: "long" });
  const media = d.permissions.filter((p) => p.startsWith("media-")).map(say);
  const others = d.permissions.filter((p) => !p.startsWith("media-")).map(say);
  const parts = [...(media.length ? [format(locale, "chrome-perm-use", { what: list.format(media) })] : []), ...others];
  // Never throws: an unreadable origin (about:blank, data:…) is shown as it is.
  const text = format(locale, "chrome-banner", { site: siteOf(d.origin), what: list.format(parts) });
  return d.link ? format(locale, "chrome-banner-link", { text, link: d.link.slice(0, 120) }) : text;
}
