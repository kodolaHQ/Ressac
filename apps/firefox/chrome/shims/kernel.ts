// Pure helpers of the kernel, re-exported from their files (never from index.ts, which pulls in Node-only code).
export * from "../../../../packages/kernel/src/mcp/bridge";
export { localUrl } from "../../../../packages/kernel/src/workflows/access";
export { portRange } from "../../../../packages/kernel/src/container/ports";
export { relativeUrl, matchesPattern, hostInSite, tweaksFor } from "../../../../packages/kernel/src/sites/urls";
// Copied: it lives in mcp/server.ts, which imports the MCP SDK.
export const navigationOutsideSite = (url: string) => `L'appli de site ne va que sur ses domaines : ${url} refusée.`;
export { sitePacing } from "../../../../packages/kernel/src/workflows/pacing";
export { truncate } from "../../../../packages/kernel/src/devtools/summaries";
export { validatePassport, validateEntry, canonicalOf, maskedDisplay, cleanOrigin, PASSPORT_FIELDS, FIELD_LABEL, FIELD_GROUP, PASSPORT_LIMITS, PASSPORT_PROFILE, dayFirst, guessField, splitName } from "../../../../packages/kernel/src/mask/passport-fields";
export type { PassportEntry, PassportField, Problem } from "../../../../packages/kernel/src/mask/passport-fields";
export type { MaskedRun } from "../../../../packages/kernel/src/mask/mask";
export type { DevRight } from "../../../../packages/kernel/src/access/policy";
export type { ChangeHost } from "../../../../packages/kernel/src/workflows/pacing";
export type { ReadPage } from "../../../../packages/kernel/src/workflows/protocol";
// Copied: design/remarks.ts imports node:crypto and node:fs. What core/design/viewfinder.ts imports, so it
// loads as is in the store (test/shims.test.ts compares them with the originals).
import { HTML_MAX, TRUNCATED } from "../../shared/design-guards";
export { HTML_MAX, TRUNCATED };
export const CAPTURE_MARGIN = 16;
export const VIEWFINDER_WORLD = 1999;
export const USEFUL_STYLES = [
  "color", "background-color", "font-family", "font-size", "font-weight", "line-height", "text-align", "width", "height",
  "margin-top", "margin-right", "margin-bottom", "margin-left", "padding-top", "padding-right", "padding-bottom", "padding-left",
  "border-top-width", "border-right-width", "border-bottom-width", "border-left-width", "border-style", "border-color",
  "border-radius", "display", "position",
] as const;
export function truncateHtml(html: string): string {
  return html.length > HTML_MAX ? html.slice(0, HTML_MAX) + TRUNCATED : html;
}
