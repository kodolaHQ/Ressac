import { isIP } from "node:net";
import { z } from "zod";
import { adresseLocale } from "../workflows/acces.js";

export const SITE_JSON_MAX = 64 * 1024;
export const RETOUCHE_MAX = 256 * 1024;
export const RETOUCHES_MAX_TOTAL = 1024 * 1024;

export const ADRESSE_HORS_DOMAINES = "adresse : son domaine doit être dans domaines";
export const CADRES_MOTIFS =
  'retouches.cadres : false, ou une liste de motifs d\'adresses complètes (ex. ["https://*.lecteur.example/*"])';
export const CORRESPOND_CHEMIN = 'retouches.correspond : des chemins qui commencent par « / » (ex. "/series/*")';
export const fichierRetoucheIntrouvable = (f: string) => `retouches : fichier introuvable ou trop gros : ${f}`;
export const DOMAINE_INVALIDE = "domaines, connexion : de vrais noms de domaine (avec un point), jamais une adresse IP ni locale";
export const ERREUR_ID_SITE = "nom de dossier non pris en charge : minuscules, chiffres et tirets seulement, 60 caractères au plus (ex. mon-site)";
/** L'id sert d'hôte de `webaios-site://<id>` et de partition `persist:site-<id>`. */
export const ID_SITE = /^[a-z0-9][a-z0-9-]{0,59}$/;
export const HTTPS_SEULEMENT = "adresse : https seulement, jamais une adresse locale";

/** Un hôte en minuscules : sans schéma, sans joker, sans port, sans chemin. */
const hote = z
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

const cheminRetouche = (extensions: RegExp, texte: string) => z
  .string()
  .max(200)
  .regex(extensions, texte)
  .refine((p) => !p.startsWith("/") && !p.split("/").some((s) => s === ".." || s === "." || s === ""), "chemin relatif sans « .. »");

const motifCadre = z
  .string()
  .max(500)
  .refine((m) => m.startsWith("https://"), CADRES_MOTIFS);

const Retouche = z
  .object({
    correspond: z.array(z.string().max(500).refine((m) => m.startsWith("/"), CORRESPOND_CHEMIN)).min(1).max(20),
    js: z.array(cheminRetouche(/^[A-Za-z0-9._/-]+\.(js|mjs)$/, "chemin relatif vers un .js ou .mjs")).max(20).default([]),
    css: z.array(cheminRetouche(/^[A-Za-z0-9._/-]+\.css$/, "chemin relatif vers un .css")).max(20).default([]),
    cadres: z.union([z.literal(false), z.array(motifCadre).min(1).max(20)], { error: CADRES_MOTIFS }).default(false),
  })
  .strict();
export type Retouche = z.infer<typeof Retouche>;

export const DeclarationSite = z
  .object({
    nom: z.string().min(1).max(60),
    description: z.string().max(200).default(""),
    adresse: url,
    domaines: z.array(hote).min(1).max(20),
    connexion: z.array(hote).max(10).default([]),
    suiviAdresse: z.object({ page: url, motif: z.string().min(2).max(60) }).strict().optional(),
    retouches: z.array(Retouche).max(20).default([]),
    reprise: z.boolean().default(false),
    icone: z
      .string()
      .max(200)
      .regex(/^[A-Za-z0-9._/-]+\.(png|svg|jpg|webp)$/, "chemin relatif vers une image .png, .svg, .jpg ou .webp")
      .refine((p) => !p.startsWith("/") && !p.split("/").some((s) => s === ".." || s === "." || s === ""), "chemin relatif sans « .. »")
      .optional(),
  })
  .strict();
export type DeclarationSite = z.infer<typeof DeclarationSite>;

/** https, ou (tests) http d'un hôte local ; jamais d'identifiants ; jamais une adresse locale hors tests. */
function adresseAcceptee(brute: string, adressesLocales: boolean): URL | null {
  let u: URL;
  try {
    u = new URL(brute);
  } catch {
    return null;
  }
  if (u.username || u.password) return null;
  const local = adresseLocale(u.hostname);
  if (u.protocol === "https:") return local && !adressesLocales ? null : u;
  if (u.protocol === "http:" && adressesLocales && local) return u;
  return null;
}

/**
 * Un vrai nom de domaine pour un site : ni adresse IP, ni nom sans point (intranet), ni dernier libellé numérique, ni
 * adresse locale (sauf `adressesLocales`, tests seulement). Même règle pour `domaines`, `connexion` et l'adresse suivie.
 */
export function domaineVrai(h: string, adressesLocales: boolean): boolean {
  return !isIP(h) && h.includes(".") && !/\.\d+$/.test(h) && (adressesLocales || !adresseLocale(h));
}

/** Les règles que le schéma seul ne dit pas : l'adresse et la page de suivi, et le domaine de l'adresse. */
export function verifierDeclarationSite(d: DeclarationSite, o: { adressesLocales: boolean }): string | null {
  const depart = adresseAcceptee(d.adresse, o.adressesLocales);
  if (!depart) return HTTPS_SEULEMENT;
  if (d.suiviAdresse && !adresseAcceptee(d.suiviAdresse.page, o.adressesLocales)) return HTTPS_SEULEMENT;
  const vrai = (h: string) => domaineVrai(h, o.adressesLocales);
  if (![...d.domaines, ...d.connexion].every(vrai) || [...d.domaines, ...d.connexion].some((h) => h === "localhost" || h.endsWith(".")))
    return DOMAINE_INVALIDE;
  const h = depart.hostname.toLowerCase();
  if (!d.domaines.some((dom) => h === dom || h.endsWith(`.${dom}`))) return ADRESSE_HORS_DOMAINES;
  return null;
}
