// Pure helpers of the kernel, re-exported from their files (never from index.ts, which pulls in Node-only code).
export * from "../../../../packages/noyau/src/mcp/pont";
export { localUrl } from "../../../../packages/noyau/src/workflows/acces";
export { relativeUrl, correspondMotif, hostInSite, tweaksFor } from "../../../../packages/noyau/src/sites/adresses";
// Copied: it lives in mcp/serveur.ts, which imports the MCP SDK.
export const navigationOutsideSite = (url: string) => `L'appli de site ne va que sur ses domaines : ${url} refusée.`;
export { siteMenage } from "../../../../packages/noyau/src/workflows/menagement";
export { truncate } from "../../../../packages/noyau/src/outils-dev/resumes";
export type { DroitDev } from "../../../../packages/noyau/src/acces/politique";
export type { ChangeHost } from "../../../../packages/noyau/src/workflows/menagement";
export type { PageLue } from "../../../../packages/noyau/src/workflows/protocole";
// Copied: design/remarques.ts imports node:crypto and node:fs. What core/design/viseur.ts imports, so it
// loads as is in the store (test/shims.test.ts compares them with the originals).
import { HTML_MAX, TRONQUE } from "../../shared/design-guards";
export { HTML_MAX, TRONQUE as TRUNCATED };
export const MARGE_CAPTURE = 16;
export const VIEWFINDER_WORLD = 1999;
export const STYLES_UTILES = [
  "color", "background-color", "font-family", "font-size", "font-weight", "line-height", "text-align", "width", "height",
  "margin-top", "margin-right", "margin-bottom", "margin-left", "padding-top", "padding-right", "padding-bottom", "padding-left",
  "border-top-width", "border-right-width", "border-bottom-width", "border-left-width", "border-style", "border-color",
  "border-radius", "display", "position",
] as const;
export function truncateHtml(html: string): string {
  return html.length > HTML_MAX ? html.slice(0, HTML_MAX) + TRONQUE : html;
}
