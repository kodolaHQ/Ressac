// Pure helpers of the kernel, re-exported from their files (never from index.ts, which pulls in Node-only code).
export * from "../../../../packages/noyau/src/mcp/pont";
export { adresseLocale } from "../../../../packages/noyau/src/workflows/acces";
// Copied: it lives in mcp/serveur.ts, which imports the MCP SDK.
export const navigationHorsSite = (url: string) => `L'appli de site ne va que sur ses domaines : ${url} refusée.`;
export { siteMenage } from "../../../../packages/noyau/src/workflows/menagement";
export { tronquer } from "../../../../packages/noyau/src/outils-dev/resumes";
export type { DroitDev } from "../../../../packages/noyau/src/acces/politique";
export type { ChangerHote } from "../../../../packages/noyau/src/workflows/menagement";
export type { PageLue } from "../../../../packages/noyau/src/workflows/protocole";
