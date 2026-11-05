import { contientIndiceReseau } from "../../shared/indices-reseau";

/**
 * Electron's CSP (main/agent/accueil.ts), copied: a resource:// file cannot carry a response header, so the CSP is
 * injected as a `<meta http-equiv>` into the copy the sidebar writes.
 */
export const CSP_WIDGET =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; form-action 'none'; frame-src 'none'; require-trusted-types-for 'script'; trusted-types default";
/** Servi à la place d'un affichage qui contient un indice réseau (copie d'indices-reseau.ts, Electron). */
export const AFFICHAGE_REFUSE =
  '<!doctype html><meta charset="utf-8"><p style="font: 13px system-ui; color: #b44">Affichage refusé : il contient &lt;link&gt;, &lt;meta http-equiv&gt; ou des règles de spéculation, qui feraient sortir des données. Voir AGENTS.md.</p>';

const ID_WIDGET = /^[a-z0-9-]+$/;
const PREFIXE = "webaios-widget-";

/** Le nom de la substitution resource:// d'un widget : `webaios-widget-<id>`. */
function nomSubstitution(id: string): string {
  return `${PREFIXE}${id}`;
}

/** L'URL du cadre : la copie assainie, datée du mtime de la source (un nouveau mtime recharge le cadre). */
export function urlAffichage(id: string, mtime: number): string {
  return `resource://${PREFIXE}${id}/affichage-${mtime}.html`;
}

/** Le dossier des copies d'un widget : `<dataDir>/webaios-widgets/<id>/`. */
function dossierCopies(dataDir: string, id: string): string {
  return PathUtils.join(dataDir, "webaios-widgets", id);
}

/**
 * Le dossier des copies, créé puis confiné à `<dataDir>/webaios-widgets` : un dossier de copies qui est un lien
 * symbolique est refusé. Rend son vrai chemin, où les copies sont écrites.
 */
async function dossierCopiesConfine(dataDir: string, id: string): Promise<string | null> {
  const dossier = dossierCopies(dataDir, id);
  await IOUtils.makeDirectory(dossier, { createAncestors: true, ignoreExisting: true });
  const racine = cheminReel(PathUtils.join(dataDir, "webaios-widgets"));
  const reel = cheminReel(dossier);
  return racine && reel && reel.startsWith(racine + "/") ? reel : null;
}

/** La copie assainie d'un affichage : `<dossierCopies>/affichage-<mtime>.html`. */
export function cheminCopie(dataDir: string, id: string, mtime: number): string {
  return PathUtils.join(dossierCopies(dataDir, id), `affichage-${mtime}.html`);
}

/**
 * `realpath`, en synchrone (`nsIFile.normalize`). L'agent écrit dans les dossiers des widgets : un lien symbolique ne
 * doit pas y montrer un fichier du Mac.
 */
function cheminReel(chemin: string): string | null {
  try {
    const fichier = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    fichier.initWithPath(chemin);
    fichier.normalize();
    return fichier.path;
  } catch {
    return null;
  }
}

/** Le vrai chemin de `<dataDir>/espace/accueil/widgets/<id>/affichage.html`, confiné au dossier du widget. */
function cheminSource(dataDir: string, id: string): string | null {
  if (!ID_WIDGET.test(id)) return null;
  const widgetsDir = PathUtils.join(dataDir, "espace", "accueil", "widgets");
  const dossier = PathUtils.join(widgetsDir, id);
  const racine = cheminReel(widgetsDir);
  const reelDossier = cheminReel(dossier);
  const reelFichier = cheminReel(PathUtils.join(dossier, "affichage.html"));
  if (!racine || !reelDossier || !reelFichier) return null;
  return reelDossier.startsWith(racine + "/") && reelFichier.startsWith(reelDossier + "/") ? reelFichier : null;
}

/** Le texte servi : la meta CSP d'abord (avant tout script) ; AFFICHAGE_REFUSE si le HTML contient un indice réseau. */
export function affichageServi(html: string): string {
  if (contientIndiceReseau(html)) return AFFICHAGE_REFUSE;
  const meta = `<meta http-equiv="Content-Security-Policy" content="${CSP_WIDGET}">`;
  const doctype = html.match(/^\s*<!doctype[^>]*>/i);
  return doctype ? `${doctype[0]}${meta}${html.slice(doctype[0].length)}` : meta + html;
}

/** La substitution resource:// du widget, ou `null` pour la retirer. */
function substituer(id: string, dossier: string | null): void {
  const { FileUtils } = ChromeUtils.importESModule("resource://gre/modules/FileUtils.sys.mjs");
  Services.io
    .getProtocolHandler("resource")
    .QueryInterface(Ci.nsIResProtocolHandler)
    .setSubstitution(nomSubstitution(id), dossier ? Services.io.newFileURI(new FileUtils.File(dossier)) : null);
}

/**
 * Prépare l'affichage d'un widget : écrit sa copie assainie si le mtime de la source a changé, puis pose la
 * substitution `resource://webaios-widget-<id>/`. Rend l'URL du cadre, ou null si l'affichage est absent ou sort de son
 * dossier.
 */
export async function preparerWidget(dataDir: string, id: string): Promise<string | null> {
  const source = cheminSource(dataDir, id);
  if (!source) return null;
  let mtime: number;
  try {
    mtime = Math.round((await IOUtils.stat(source)).lastModified);
  } catch {
    return null;
  }
  const dossier = dossierCopies(dataDir, id);
  try {
    const reel = await dossierCopiesConfine(dataDir, id);
    if (!reel) {
      console.warn(`[widget] dossier de copies de ${id} hors de <dataDir>/webaios-widgets : refusé`);
      return null;
    }
    const copie = PathUtils.join(reel, `affichage-${mtime}.html`);
    // Même mtime : la copie existe déjà, on ne la réécrit pas (l'URL ne change pas).
    if (!(await IOUtils.exists(copie))) {
      // shortcut: the source is read by the realpath computed just before; a symlink swapped in by another process
      // between the check and the read is still followed (IOUtils has no O_NOFOLLOW). Upgrade if the widgets folder can
      // be written by an untrusted process.
      // Écriture atomique (motif de site-permissions.ts) : un cadre ne lit jamais une copie à moitié écrite.
      const temporaire = `${copie}.${crypto.randomUUID()}.tmp`;
      await IOUtils.writeUTF8(temporaire, affichageServi(await IOUtils.readUTF8(source)), { flush: true });
      await IOUtils.move(temporaire, copie);
      // Une seule copie par widget : la précédente est retirée.
      for (const ancien of await IOUtils.getChildren(reel)) {
        if (ancien !== copie && /affichage-.*\.html$/.test(ancien)) await IOUtils.remove(ancien, { ignoreAbsent: true });
      }
    }
    substituer(id, dossier);
  } catch (e) {
    console.error(`[widget] copie de ${id} impossible :`, e);
    return null;
  }
  return urlAffichage(id, mtime);
}

/** Le widget n'existe plus : retire sa substitution et son dossier de copies (au mieux). */
export async function oublierWidget(dataDir: string, id: string): Promise<void> {
  if (!ID_WIDGET.test(id)) return;
  try {
    substituer(id, null);
  } catch {
    // rien à retirer
  }
  await IOUtils.remove(dossierCopies(dataDir, id), { recursive: true, ignoreAbsent: true }).catch(() => {});
}
