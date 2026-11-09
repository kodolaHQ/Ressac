import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { basename, dirname, join, posix } from "node:path";
import { analyserManifeste, fichiersMessages, type AnalyseManifeste } from "./manifeste.js";

/** Dossier des gardes livrés avec le noyau ; un navigateur qui embarque le noyau peut en fournir un autre. */
export const GARDES_PAR_DEFAUT = join(import.meta.dirname, "..", "..", "extensions");

export const FICHIERS_MAX = 2000;
export const TAILLE_MAX = 20 * 1024 * 1024;
/** Fichiers et dossiers comptés ensemble. */
export const ENTREES_MAX = 5000;
export const PROFONDEUR_MAX = 32;

const CORRECTIFS_PAGE = "webaios-correctifs-page.js";
const GARDE_PAGE = "webaios-garde-page.js";
const GARDE_FOND = "webaios-garde-fond.js";
const FOND = "webaios-fond.js";
const GARDES = [CORRECTIFS_PAGE, GARDE_PAGE, GARDE_FOND];
/** La portée de la copie (`reseau`, `hotes`) pour la garde de page : injectée par executeScript et registerContentScripts. */
const PORTEE = "webaios-portee.js";
/**
 * Un repère par fichier .js ou .css de l'agent (`webaios-fichiers/<n>.js` : `__webaiosFichier(n)`). Les scripts de contenu
 * (manifeste et registerContentScripts) ne déclarent que les gardes et ces repères ; le garde du fond injecte les vrais
 * fichiers après la réponse du processus principal (un onglet), par la table mise en tête de webaios-garde-fond.js.
 */
const REPERES = "webaios-fichiers";

/** CSP d'une copie de l'agent : `connect-src` ne s'ouvre qu'aux domaines de `reseau`, en https et en wss (WebSocket). */
export function cspAgent(reseau: readonly string[]): string {
  return (
    "default-src 'self'; script-src 'self'; object-src 'none'; connect-src 'self'" +
    reseau.map((d) => ` https://${d} wss://${d}`).join("") +
    "; img-src 'self' data:; style-src 'self' 'unsafe-inline'; form-action 'none'; frame-ancestors 'self'"
  );
}

type Manifeste = Record<string, unknown>;

function objet(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** JSON d'un fichier (BOM toléré) ; `undefined` s'il est illisible. */
function json(contenu: Buffer | undefined): unknown {
  if (!contenu) return undefined;
  try {
    return JSON.parse(contenu.toString("utf8").replace(/^﻿/, ""));
  } catch {
    return undefined;
  }
}

class RefusLecture extends Error {}

const LIENS = new Set(["ELOOP", "EMLINK", "ENOTDIR"]);
// O_NOFOLLOW : un lien à la place du fichier fait échouer l'ouverture ; O_NONBLOCK : un tube ne bloque pas.
const DRAPEAUX_LECTURE = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

/** Le dossier source réellement lu (chemin résolu, dev/ino) : l'appelant vérifie que c'est celui qu'il a contrôlé. */
export interface RacineLue {
  chemin: string;
  dev: number;
  ino: number;
}

interface Repere {
  chemin: string;
  dev: number;
  ino: number;
}

/**
 * Fichiers ordinaires du dossier (chemins relatifs en `/`), lus sans suivre aucun lien. Chaque fichier est ouvert
 * en `O_NOFOLLOW` et doit être celui vu par `lstat` (même dev/ino), sans autre lien physique ; chaque dossier doit
 * rester le même pendant sa lecture, et les dossiers parents sont revérifiés après chaque fichier. Un lien, un
 * fichier spécial, un remplacement pendant la lecture, ou un dépassement des limites donne un refus (le parcours
 * s'arrête).
 */
async function lireDossier(source: string): Promise<{ fichiers: Map<string, Buffer>; refus: string[]; racine?: RacineLue }> {
  const fichiers = new Map<string, Buffer>();
  const racine = join(await realpath(dirname(source)), basename(source));
  let taille = 0;
  let entrees = 0;
  const refuser = (message: string): never => {
    throw new RefusLecture(message);
  };
  const absolu = (rel: string) => (rel ? join(racine, rel) : racine);
  const verifierDossiers = async (chaine: Repere[]): Promise<void> => {
    for (const d of chaine) {
      const info = await lstat(absolu(d.chemin)).catch(() => null);
      if (!info?.isDirectory() || info.dev !== d.dev || info.ino !== d.ino) {
        refuser(`Dossier remplacé pendant la lecture : ${d.chemin || "."}`);
      }
    }
  };
  const lireFichier = async (chemin: string, vu: Repere): Promise<Buffer> => {
    let fh: FileHandle;
    try {
      fh = await open(absolu(chemin), DRAPEAUX_LECTURE);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? "";
      if (LIENS.has(code)) refuser(`Lien symbolique refusé : ${chemin}`);
      if (code === "ENOENT") refuser(`Fichier remplacé pendant la lecture : ${chemin}`);
      throw e;
    }
    try {
      const info = await fh.stat();
      if (!info.isFile() || info.dev !== vu.dev || info.ino !== vu.ino) {
        refuser(`Fichier remplacé pendant la lecture : ${chemin}`);
      }
      if (info.nlink !== 1) refuser(`Lien physique refusé : ${chemin}`);
      const reste = TAILLE_MAX - taille;
      const morceaux: Buffer[] = [];
      let lu = 0;
      for (;;) {
        const tampon = Buffer.alloc(Math.min(64 * 1024, reste + 1 - lu));
        const { bytesRead } = await fh.read(tampon, 0, tampon.length, null);
        if (bytesRead === 0) break;
        morceaux.push(tampon.subarray(0, bytesRead));
        lu += bytesRead;
        if (lu > reste) refuser(`Extension trop lourde : ${TAILLE_MAX / 1024 / 1024} Mo au plus`);
      }
      taille += lu;
      return Buffer.concat(morceaux);
    } finally {
      await fh.close();
    }
  };
  const parcourir = async (chaine: Repere[]): Promise<void> => {
    const dossier = chaine[chaine.length - 1]!;
    let noms: string[];
    try {
      noms = (await readdir(absolu(dossier.chemin))).sort();
    } catch (e) {
      if (["ENOENT", ...LIENS].includes((e as NodeJS.ErrnoException).code ?? "")) {
        refuser(`Dossier remplacé pendant la lecture : ${dossier.chemin || "."}`);
      }
      throw e;
    }
    await verifierDossiers(chaine);
    for (const nom of noms) {
      const chemin = dossier.chemin ? `${dossier.chemin}/${nom}` : nom;
      if (++entrees > ENTREES_MAX) refuser(`Trop d'entrées : ${ENTREES_MAX} fichiers et dossiers au plus`);
      if (chemin.split("/").length > PROFONDEUR_MAX) refuser(`Arborescence trop profonde : ${PROFONDEUR_MAX} niveaux au plus`);
      const info = await lstat(absolu(chemin)).catch(() => refuser(`Fichier remplacé pendant la lecture : ${chemin}`));
      const repere = { chemin, dev: info.dev, ino: info.ino };
      if (info.isSymbolicLink()) refuser(`Lien symbolique refusé : ${chemin}`);
      if (info.isDirectory()) {
        await parcourir([...chaine, repere]);
        continue;
      }
      if (!info.isFile()) refuser(`Fichier spécial refusé : ${chemin}`);
      if (fichiers.size >= FICHIERS_MAX) refuser(`Trop de fichiers : ${FICHIERS_MAX} au plus`);
      fichiers.set(chemin, await lireFichier(chemin, repere));
      await verifierDossiers(chaine);
    }
  };
  let lue: RacineLue | undefined;
  try {
    const info = await lstat(racine);
    if (!info.isDirectory()) refuser("Le dossier de l'extension n'est pas un dossier");
    lue = { chemin: racine, dev: info.dev, ino: info.ino };
    await parcourir([{ chemin: "", dev: info.dev, ino: info.ino }]);
  } catch (e) {
    if (e instanceof RefusLecture) return { fichiers, refus: [e.message], ...(lue ? { racine: lue } : {}) };
    throw e;
  }
  return { fichiers, refus: [], racine: lue };
}

function empreinteDe(fichiers: Map<string, Buffer>): string {
  const h = createHash("sha256");
  for (const chemin of [...fichiers.keys()].sort()) {
    const contenu = fichiers.get(chemin)!;
    h.update(`${chemin}\0${contenu.length}\0`);
    h.update(contenu);
  }
  return h.digest("hex");
}

/** Règles DNR statiques déclarées par le manifeste, lues parmi les fichiers du dossier (absentes si illisibles). */
function reglesDe(manifeste: unknown, fichiers: Map<string, Buffer>): Record<string, unknown> {
  const regles: Record<string, unknown> = {};
  const ressources = objet(objet(manifeste)?.declarative_net_request)?.rule_resources;
  if (!Array.isArray(ressources)) return regles;
  for (const res of ressources) {
    const chemin = objet(res)?.path;
    if (typeof chemin !== "string") continue;
    const contenu = json(fichiers.get(posix.normalize(chemin)));
    if (contenu !== undefined) regles[chemin] = contenu;
  }
  return regles;
}

/** Les fichiers que le fond peut injecter dans une page : chaque .js et .css de l'agent, triés (l'indice est le repère). */
function tableDesFichiers(fichiers: Map<string, Buffer>): [string, "js" | "css"][] {
  const table: [string, "js" | "css"][] = [];
  for (const chemin of [...fichiers.keys()].sort()) {
    if (/\.js$/i.test(chemin)) table.push([chemin, "js"]);
    else if (/\.css$/i.test(chemin)) table.push([chemin, "css"]);
  }
  return table;
}

/**
 * Chaque entrée `content_scripts[i]` ne déclare plus que les gardes, la portée et un repère par fichier (CSS d'abord,
 * puis JS, dans l'ordre du manifeste) ; son `css` est retiré. Rien de l'agent n'y est collé : ses fichiers sont injectés
 * par le fond après la réponse. Refus : un fichier absent ou hors du dossier. Rend aussi les sites de ces entrées.
 */
function reecrireScripts(
  manifeste: Manifeste,
  table: [string, "js" | "css"][],
): { refus: string[]; sites: string[] } {
  const refus: string[] = [];
  const sites: string[] = [];
  if (!Array.isArray(manifeste.content_scripts)) return { refus, sites };
  const indice = new Map(table.map(([chemin, genre], i) => [`${genre}:${chemin}`, i]));
  manifeste.content_scripts = manifeste.content_scripts.map((cs) => {
    const c = objet(cs);
    if (!c) return cs;
    const reperes: string[] = [];
    for (const genre of ["css", "js"] as const) {
      if (!Array.isArray(c[genre])) continue;
      for (const brut of c[genre] as unknown[]) {
        const chemin = typeof brut === "string" ? posix.normalize(brut.replace(/^\/+/, "")) : "";
        const i = indice.get(`${genre}:${chemin}`);
        if (!chemin || chemin.startsWith("../") || i === undefined) refus.push(`Script de contenu introuvable : ${String(brut)}`);
        else reperes.push(`${REPERES}/${i}.js`);
      }
    }
    if (reperes.length === 0) return cs;
    for (const m of Array.isArray(c.matches) ? c.matches : []) if (typeof m === "string" && !sites.includes(m)) sites.push(m);
    const { css: _css, ...reste } = c;
    return { ...reste, js: [CORRECTIFS_PAGE, GARDE_PAGE, PORTEE, ...reperes] };
  });
  return { refus, sites };
}

const BALISE_GARDE = Buffer.from(`<script src="/${GARDE_FOND}"></script>`);
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

/**
 * Préfixe les octets d'une page HTML par le garde de fond (après un BOM et un `<!doctype …>` placés tout au
 * début) : rien ne peut le précéder, ni commentaire, ni `<base>`, ni changement d'encodage ; le reste est intact.
 */
function insererGardePage(page: Buffer): Buffer {
  let position = page.subarray(0, 3).equals(BOM) ? 3 : 0;
  const doctype = /^<!doctype[^>]*>/i.exec(page.subarray(position, position + 1024).toString("latin1"));
  if (doctype) position += doctype[0].length;
  return Buffer.concat([page.subarray(0, position), BALISE_GARDE, page.subarray(position)]);
}

const DOCUMENTS_REFUSES = /\.(xhtml|xht|xml|xsl|xslt|mht|mhtml|svgz)$/i;
const PAGES = /\.(html?|shtml)$/i;
const MOTS_SVG = ["javascript:", "script", "foreignobject", "<!entity"];

/** BOM UTF-16 (FF FE, FE FF) ou UTF-32 (FF FE 00 00, 00 00 FE FF). */
function bomUtf16Ou32(o: Buffer): boolean {
  return (
    (o[0] === 0xff && o[1] === 0xfe) ||
    (o[0] === 0xfe && o[1] === 0xff) ||
    (o.length >= 4 && o[0] === 0 && o[1] === 0 && o[2] === 0xfe && o[3] === 0xff)
  );
}

/** Règle fermée : la raison du refus d'un SVG, ou null s'il est accepté. */
function refusSvg(contenu: Buffer): string | null {
  if (bomUtf16Ou32(contenu)) return "encodage UTF-16 ou UTF-32";
  if (contenu.includes(0)) return "octet NUL";
  let texte: string;
  try {
    texte = new TextDecoder("utf-8", { fatal: true }).decode(contenu).toLowerCase();
  } catch {
    return "UTF-8 invalide";
  }
  const mot = MOTS_SVG.find((m) => texte.includes(m));
  if (mot) return `contient « ${mot} »`;
  if (/\bon[a-z]+\s*=/i.test(texte)) return "attribut on…=";
  return null;
}

/** Refus propres au contenu des fichiers : noms réservés, documents hors HTML, SVG actifs, pages en UTF-16/32. */
function refusFichiers(fichiers: Map<string, Buffer>): string[] {
  const refus: string[] = [];
  const reserves = new Set([FOND, ...GARDES]);
  for (const [chemin, contenu] of fichiers) {
    // Tout nom de premier niveau en « webaios- » : gardes, portée, repères (webaios-fichiers/).
    const premier = chemin.split("/")[0]!.normalize("NFC").toLowerCase();
    if (reserves.has(premier) || premier.startsWith("webaios-")) refus.push(`Nom de fichier réservé à WebAiOs : ${chemin}`);
    const document = DOCUMENTS_REFUSES.exec(chemin);
    if (document) refus.push(`Type de fichier refusé (.${document[1]!.toLowerCase()}) : ${chemin}`);
    if (/\.svg$/i.test(chemin)) {
      const raison = refusSvg(contenu);
      if (raison) refus.push(`Image SVG refusée (${raison}) : ${chemin}`);
    }
    if (PAGES.test(chemin) && bomUtf16Ou32(contenu)) {
      refus.push(`Page HTML refusée (encodage UTF-16 ou UTF-32) : ${chemin}`);
    }
  }
  return refus;
}

const FOND_MINIMAL_AGENT = `// Généré par WebAiOs : l'extension n'a pas de fond ; celui-ci, le garde seul, active ses rulesets et onInstalled.\nimportScripts(${JSON.stringify(GARDE_FOND)});\n`;
function fondGenere(original: string, module: boolean): string {
  const chemin = original.replace(/^(\.\/|\/)+/, "");
  const entete = "// Généré par WebAiOs : le garde, puis le service worker de l'extension.\n";
  if (module) return `${entete}import "./${GARDE_FOND}";\nimport ${JSON.stringify("./" + chemin)};\n`;
  return `${entete}importScripts(${JSON.stringify(GARDE_FOND)}, ${JSON.stringify(chemin)});\n`;
}

/** Met `nouveau` à la place de `cible` : deux renommages (un dossier non vide ne se remplace pas d'un coup). */
async function remplacerDossier(nouveau: string, cible: string): Promise<void> {
  const ancien = `${cible}.${randomUUID()}.ancienne`;
  let deplace = false;
  try {
    await rename(cible, ancien);
    deplace = true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  try {
    await rename(nouveau, cible);
  } catch (e) {
    if (deplace) await rename(ancien, cible).catch(() => undefined);
    throw e;
  }
  if (deplace) await rm(ancien, { recursive: true, force: true });
}

/**
 * Copie contrôlée d'une extension de l'agent : `source` est lu sans suivre aucun lien, analysé, et s'il n'y a
 * aucun refus, la copie (CSP imposée, gardes en tête, `webaios.json`, `key` et `update_url` retirés) remplace
 * `cible` d'un coup. Avec un refus, rien n'est écrit.
 */
export async function preparerCopie(o: {
  source: string;
  cible: string;
  dossierGardes: string;
}): Promise<{ analyse: AnalyseManifeste; empreinte: string; racine?: RacineLue }> {
  const { fichiers, refus: refusDossier, racine } = await lireDossier(o.source);
  const brut = json(fichiers.get("manifest.json"));
  const webaiosBrut = fichiers.get("webaios.json");
  const webaios = webaiosBrut === undefined ? undefined : (json(webaiosBrut) ?? "illisible");
  const messages = fichiersMessages(brut).map((f) => json(fichiers.get(f)));
  const analyse = analyserManifeste(brut, { source: "agent", webaios, regles: reglesDe(brut, fichiers), messages });
  analyse.refus = [...refusDossier, ...refusFichiers(fichiers), ...analyse.refus];
  const empreinte = empreinteDe(fichiers);
  const lue = racine ? { racine } : {};
  if (analyse.refus.length > 0) return { analyse, empreinte, ...lue };

  const manifeste = { ...(brut as Manifeste) };
  delete manifeste.key;
  delete manifeste.update_url;
  manifeste.content_security_policy = { extension_pages: cspAgent(analyse.portee.reseau) };
  const portee = `globalThis.__webaiosPortee(${JSON.stringify({ reseau: analyse.portee.reseau, hotes: analyse.portee.hotes })});`;
  const table = tableDesFichiers(fichiers);
  const reecrits = reecrireScripts(manifeste, table);
  if (reecrits.refus.length > 0) {
    analyse.refus = [...analyse.refus, ...reecrits.refus];
    return { analyse, empreinte, ...lue };
  }
  if (reecrits.sites.length > 0) {
    // Le fond injecte les fichiers par `scripting`, qui demande le droit et les hôtes des scripts de contenu (déjà
    // accordés : la portée compte ces sites). Seule la copie les porte, l'analyse reste celle de la source.
    const permissions = Array.isArray(manifeste.permissions) ? (manifeste.permissions as unknown[]) : [];
    if (!permissions.includes("scripting")) manifeste.permissions = [...permissions, "scripting"];
    const hotes = Array.isArray(manifeste.host_permissions) ? (manifeste.host_permissions as unknown[]) : [];
    manifeste.host_permissions = [...hotes, ...reecrits.sites.filter((x) => !hotes.includes(x))];
  }
  const fond = objet(manifeste.background);
  let fondJs: string;
  if (fond && typeof fond.service_worker === "string") {
    fondJs = fondGenere(fond.service_worker, fond.type === "module");
    manifeste.background = { ...fond, service_worker: FOND };
  } else {
    // Without a background, nothing would activate its rulesets or fire onInstalled (the guard runs in the background):
    // a minimal background, the guard alone, is declared.
    fondJs = FOND_MINIMAL_AGENT;
    manifeste.background = { service_worker: FOND };
  }

  const tmp = `${o.cible}.${randomUUID()}.tmp`;
  try {
    await mkdir(tmp, { recursive: true });
    for (const [chemin, contenu] of fichiers) {
      if (chemin === "webaios.json" || chemin === "manifest.json") continue;
      const destination = join(tmp, chemin);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(
        destination,
        PAGES.test(chemin) ? insererGardePage(contenu) : contenu,
      );
    }
    for (const g of GARDES) await copyFile(join(o.dossierGardes, g), join(tmp, g));
    // La table en tête du garde de fond : elle est lue avant tout script de l'extension, qui ne peut plus la changer.
    await writeFile(
      join(tmp, GARDE_FOND),
      Buffer.concat([Buffer.from(`const __webaiosFichiers = ${JSON.stringify(table)};\n`), await readFile(join(o.dossierGardes, GARDE_FOND))]),
    );
    await writeFile(join(tmp, PORTEE), `${portee}\n`);
    await mkdir(join(tmp, REPERES), { recursive: true });
    for (let i = 0; i < table.length; i++) await writeFile(join(tmp, REPERES, `${i}.js`), `globalThis.__webaiosFichier(${i});\n`);
    await writeFile(join(tmp, FOND), fondJs);
    await writeFile(join(tmp, "manifest.json"), JSON.stringify(manifeste, null, 2));
    await remplacerDossier(tmp, o.cible);
  } catch (e) {
    await rm(tmp, { recursive: true, force: true });
    throw e;
  }
  return { analyse, empreinte, ...lue };
}
