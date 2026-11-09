import { isIP } from "node:net";
import { z } from "zod";
import { localUrl } from "../workflows/access.js";

export const SITE_JSON_MAX = 64 * 1024;
export const TWEAK_MAX = 256 * 1024;
export const TWEAKS_MAX_TOTAL = 1024 * 1024;

export const URL_OUTSIDE_DOMAINS = "adresse : son domaine doit être dans domaines";
export const FRAME_PATTERNS =
  'retouches.cadres : false, ou une liste de motifs d\'adresses complètes (ex. ["https://*.lecteur.example/*"])';
export const PATH_MATCHES = 'retouches.correspond : des chemins qui commencent par « / » (ex. "/series/*")';
export const tweakFileNotFound = (f: string) => `retouches : fichier introuvable ou trop gros : ${f}`;
export const INVALID_DOMAIN = "domaines, connexion : de vrais noms de domaine (avec un point), jamais une adresse IP ni locale";
export const SITE_ID_ERROR = "nom de dossier non pris en charge : minuscules, chiffres et tirets seulement, 60 caractères au plus (ex. mon-site)";
/** The id serves as host of `webaios-site://<id>` and as partition `persist:site-<id>`. */
export const ID_SITE = /^[a-z0-9][a-z0-9-]{0,59}$/;
export const HTTPS_ONLY = "adresse : https seulement, jamais une adresse locale";

/** A host in lowercase: no scheme, no wildcard, no port, no path. */
const host = z
  .string()
  .max(253)
  .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/, "hôte en minuscules, sans schéma, joker ni port");

const url = z.string().max(2048).refine((u) => {
  try {
    new URL(u);
    return true;
  } catch {
    return false;
  }
}, "URL attendue");

const tweakPath = (extensions: RegExp, text: string) => z
  .string()
  .max(200)
  .regex(extensions, text)
  .refine((p) => !p.startsWith("/") && !p.split("/").some((s) => s === ".." || s === "." || s === ""), "chemin relatif sans « .. »");

const framePattern = z
  .string()
  .max(500)
  .refine((m) => m.startsWith("https://"), FRAME_PATTERNS);

const Tweak = z
  .object({
    matches: z.array(z.string().max(500).refine((m) => m.startsWith("/"), PATH_MATCHES)).min(1).max(20),
    js: z.array(tweakPath(/^[A-Za-z0-9._/-]+\.(js|mjs)$/, "chemin relatif vers un .js ou .mjs")).max(20).default([]),
    css: z.array(tweakPath(/^[A-Za-z0-9._/-]+\.css$/, "chemin relatif vers un .css")).max(20).default([]),
    frames: z.union([z.literal(false), z.array(framePattern).min(1).max(20)], { error: FRAME_PATTERNS }).default(false),
  })
  .strict();
export type Tweak = z.infer<typeof Tweak>;

export const DeclarationSite = z
  .object({
    name: z.string().min(1).max(60),
    description: z.string().max(200).default(""),
    url: url,
    domains: z.array(host).min(1).max(20),
    login: z.array(host).max(10).default([]),
    urlTracking: z.object({ page: url, pattern: z.string().min(2).max(60) }).strict().optional(),
    tweaks: z.array(Tweak).max(20).default([]),
    resume: z.boolean().default(false),
    icon: z
      .string()
      .max(200)
      .regex(/^[A-Za-z0-9._/-]+\.(png|svg|jpg|webp)$/, "chemin relatif vers une image .png, .svg, .jpg ou .webp")
      .refine((p) => !p.startsWith("/") && !p.split("/").some((s) => s === ".." || s === "." || s === ""), "chemin relatif sans « .. »")
      .optional(),
  })
  .strict();
export type DeclarationSite = z.infer<typeof DeclarationSite>;

/** https, or (tests) http of a local host; never credentials; never a local address outside tests. */
function urlAccepted(raw: string, localUrls: boolean): URL | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.username || u.password) return null;
  const local = localUrl(u.hostname);
  if (u.protocol === "https:") return local && !localUrls ? null : u;
  if (u.protocol === "http:" && localUrls && local) return u;
  return null;
}

/**
 * A real domain name for a site: no IP address, no name without a dot (intranet), no numeric last label, no
 * local address (except `adressesLocales`, tests only). Same rule for `domaines`, `connexion` and the followed address.
 */
export function trueDomain(h: string, localUrls: boolean): boolean {
  return !isIP(h) && h.includes(".") && !/\.\d+$/.test(h) && (localUrls || !localUrl(h));
}

/** The rules that the schema alone does not state: the address and the tracking page, and the address's domain. */
export function checkSiteDeclaration(d: DeclarationSite, o: { localAddresses: boolean }): string | null {
  const start = urlAccepted(d.url, o.localAddresses);
  if (!start) return HTTPS_ONLY;
  if (d.urlTracking && !urlAccepted(d.urlTracking.page, o.localAddresses)) return HTTPS_ONLY;
  const real = (h: string) => trueDomain(h, o.localAddresses);
  if (![...d.domains, ...d.login].every(real) || [...d.domains, ...d.login].some((h) => h === "localhost" || h.endsWith(".")))
    return INVALID_DOMAIN;
  const h = start.hostname.toLowerCase();
  if (!d.domains.some((dom) => h === dom || h.endsWith(`.${dom}`))) return URL_OUTSIDE_DOMAINS;
  return null;
}
