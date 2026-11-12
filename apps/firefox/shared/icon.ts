/** Scheme the UI (no network) uses for http(s) favicons. Nothing serves it in Firefox: such an icon fails to load. */
export const ICON_SCHEMA = "webaios-icone";

/**
 * The address the UI uses to display favicon `url`: http(s) goes through `webaios-icone:`; data: stays, and so does
 * `moz-remote-image:`, which Firefox gives a tab for an SVG icon (decoded in a content process).
 */
export function iconUrl(url: string): string | null {
  if (/^(data:image\/|moz-remote-image:)/i.test(url)) return url;
  if (!/^https?:\/\//i.test(url)) return null;
  return `${ICON_SCHEMA}://site/?u=${encodeURIComponent(url)}`;
}
