// The design guards, loadable under tsx and in the sidebar bundle (no value import): PROJECT_ID lives in a kernel file
// that needs node:crypto, failureReason in core/design/external.ts needs node:fs. test/review-host.test.ts checks them.
import type { DesignContext } from "../../../packages/kernel/src/design/remarks";

/** Copy of kernel's PROJECT_ID. */
export const ID_PROJECT = /^(app-[A-Za-z0-9][A-Za-z0-9._-]*|ext-[0-9a-f]{16}|demo-\d{1,5}|site-[a-z0-9][a-z0-9-]{0,59})$/;
export const EXTERNAL_ID = /^[0-9a-f]{16}$/;
export const CLIENT_ID = /^[0-9a-f-]{8,64}$/;
export const CLIENT_NAME_MAX = 200;
/** A comparison's token: its two trees (REVIEW_TOKEN). */
export const REVIEW_TOKEN = /^[0-9a-f]{40}:[0-9a-f]{40}$/;
export const REVIEW_PATH_MAX = 4096;
export const COMMENT_ID = /^c-[0-9a-f]{8}$/;
/** REMARK_TEXT_MAX. */
export const REMARK_TEXT_MAX = 4000;

/** Copy of external.ts's failureReason. */
export const failureReason = (e: unknown): string => `Le MCP externe n'a pas pu démarrer : ${e instanceof Error ? e.message : String(e)}`;

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

export function checkLines(start: unknown, end: unknown): [number, number] {
  if (!positive(start) || !positive(end) || end < start) throw new Error("lignes invalides");
  return [start, end];
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

export function checkClientName(name: unknown): string {
  if (typeof name !== "string" || name.length > 200) throw new Error("Nom invalide");
  return name;
}

/** The design texts: the kernel's DESIGN_UNAVAILABLE, the invalid input's, the cart's. */
export const UNAVAILABLE_DESIGN = "Le mode design marche sur les applis de l'agent, les applis de site et les projets branchés par un Claude Code";
/** Copies of kernel's SITE_DESIGN_UNAVAILABLE and SITE_CAPTURE_WARNING (design/projects.ts). */
export const UNAVAILABLE_DESIGN_SITE = "Le mode design marche dans les pages du site et sur l'accueil, pas sur la carte d'accord, une page de connexion ni en plein écran";
export const CAPTURE_WARNING_SITE = "L'extrait et la capture de cet élément iront à l'agent.";
export const INVALID_REQUEST = "Demande invalide";
export const NOTHING_AIMED = "Aucun élément visé.";
/** An element's or a batch's id (`id.length <= 64`). */
export const DESIGN_ID_MAX = 64;
/** Copies of kernel's HTML_MAX and TRONQUE: a context's html is at most a cut one. */
export const HTML_MAX = 4096;
export const TRUNCATED = "… [tronqué]";
/** A capture's PNG, decoded (mine: an element's capture is far smaller). */
export const CAPTURE_MAX = 8 * 1024 * 1024;
export const URL_MAX = 8192;

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const str = (c: unknown, max = 1_000_000): c is string => typeof c === "string" && c.length <= max;
const positiveInt = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n > 0;
const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const invalid = (): never => {
  throw new Error(INVALID_REQUEST);
};

/** viewfinder.ts's cleanCapture rules (a bad shape refuses the context) and healthySource's (a bad source field is dropped), rebuilt with known keys only. */
export function checkDesignContext(c: unknown): DesignContext {
  if (!record(c) || !record(c.view) || !record(c.neighborhood) || !record(c.styles)) return invalid();
  const { selector, label, html, url, view, neighborhood: surroundings, styles, source } = c as Record<string, any>;
  if (![view.width, view.height].every(finite)) return invalid();
  if (![selector, label, url, surroundings.parent].every((x) => str(x)) || !str(html, HTML_MAX + TRUNCATED.length)) return invalid();
  if (!Array.isArray(surroundings.siblings) || !surroundings.siblings.every((f: unknown) => str(f))) return invalid();
  if (!Object.values(styles).every((x) => str(x))) return invalid();
  // As healthySource: a bad file gives no source, a bad line or column is dropped; the remark stays.
  const src: DesignContext["source"] =
    !record(source) || !str(source.file, 1024) || source.file === ""
      ? null
      : { file: source.file, ...(positiveInt(source.line) ? { line: source.line } : {}), ...(positiveInt(source.column) ? { column: source.column } : {}) };
  return {
    selector, label, html, url,
    view: { width: view.width, height: view.height },
    neighborhood: { parent: surroundings.parent, siblings: [...surroundings.siblings] },
    styles: { ...styles },
    source: src,
  };
}

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** A capture: null, or a PNG in base64 of at most CAPTURE_MAX bytes. Host side only (Buffer). */
export function checkCapture(b: unknown): Buffer | null {
  if (b === null) return null;
  if (typeof b !== "string" || b.length > Math.ceil(CAPTURE_MAX / 3) * 4) return invalid();
  const buf = Buffer.from(b, "base64");
  if (buf.length > CAPTURE_MAX || buf.length < PNG.length || PNG.some((x, i) => buf[i] !== x)) return invalid();
  return buf;
}
