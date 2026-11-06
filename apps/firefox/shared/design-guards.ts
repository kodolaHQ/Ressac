// Copies of Electron's design guards, loadable under tsx and in the sidebar bundle (no value import): main/ipc.ts keeps
// its checks private and imports electron, ID_PROJET lives in a noyau file that needs node:crypto, raisonEchec in
// externes.ts needs node:fs. test/review-host.test.ts compares each one with the original.

/** Copy of noyau's ID_PROJET. */
export const ID_PROJECT = /^(app-[A-Za-z0-9][A-Za-z0-9._-]*|ext-[0-9a-f]{16}|demo-\d{1,5}|site-[a-z0-9][a-z0-9-]{0,59})$/;
export const EXTERNAL_ID = /^[0-9a-f]{16}$/;
export const CLIENT_ID = /^[0-9a-f-]{8,64}$/;
export const CLIENT_NAME_MAX = 200;
/** A comparison's token: its two trees (JETON_RELECTURE). */
export const REVIEW_TOKEN = /^[0-9a-f]{40}:[0-9a-f]{40}$/;
export const REVIEW_PATH_MAX = 4096;
export const COMMENT_ID = /^c-[0-9a-f]{8}$/;
/** TEXTE_REMARQUE_MAX. */
export const REMARK_TEXT_MAX = 4000;

/** Copy of externes.ts's raisonEchec. */
export const raisonEchec = (e: unknown): string => `Le MCP externe n'a pas pu démarrer : ${e instanceof Error ? e.message : String(e)}`;

const positive = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 1;

export function checkProject(p: unknown): string {
  if (typeof p !== "string" || !ID_PROJECT.test(p)) throw new Error("projet invalide");
  return p;
}

export function checkToken(j: unknown): string {
  if (typeof j !== "string" || !REVIEW_TOKEN.test(j)) throw new Error("jeton invalide");
  return j;
}

export function checkPath(c: unknown): string {
  if (typeof c !== "string" || c === "" || c.length > REVIEW_PATH_MAX || c.includes("\0")) throw new Error("chemin invalide");
  return c;
}

export function checkLines(debut: unknown, fin: unknown): [number, number] {
  if (!positive(debut) || !positive(fin) || fin < debut) throw new Error("lignes invalides");
  return [debut, fin];
}

export function checkText(t: unknown): string {
  if (typeof t !== "string" || t.length > REMARK_TEXT_MAX) throw new Error("texte invalide");
  return t;
}

export function checkComment(id: unknown): string {
  if (typeof id !== "string" || !COMMENT_ID.test(id)) throw new Error("commentaire invalide");
  return id;
}

export function checkResolved(r: unknown): boolean {
  if (typeof r !== "boolean") throw new Error("résolu invalide");
  return r;
}

export function checkClientName(nom: unknown): string {
  if (typeof nom !== "string" || nom.length > 200) throw new Error("Nom invalide");
  return nom;
}
