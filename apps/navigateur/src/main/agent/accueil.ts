import { protocol, type WebContents } from "electron";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CheminsEspace, EtatAccueil, Noyau } from "@webaios/noyau";
import type { BlocAffiche } from "../../commun/api";

export const SCHEMA_BLOC = "webaios-bloc";
const ID_BLOC = /^[a-z0-9-]+$/;
/** Le HTML d'un bloc n'exécute rien et ne charge que des images, styles en ligne et polices. */
const CSP_BLOC = "default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; font-src https: data:";
const PARTITION_WEB = "persist:webaios";

/** Ce que l'interface affiche, dans l'ordre de disposition. `mtimes` : date de index.html par bloc, pour forcer le rechargement. */
export function versBlocsAffiches(etat: EtatAccueil, mtimes: Record<string, number>): BlocAffiche[] {
  return etat.ordre.flatMap((id): BlocAffiche[] => {
    const b = etat.blocs.find((x) => x.id === id);
    if (!b) return [];
    if ("erreur" in b) return [{ id, erreur: b.erreur }];
    if (b.config.type === "app") return [{ id, titre: b.config.titre, type: "app", url: b.config.url }];
    return [
      {
        id,
        titre: b.config.titre,
        type: "agent",
        src: b.cheminHtml ? `${SCHEMA_BLOC}://${id}/index.html?v=${mtimes[id] ?? 0}` : null,
        statut: b.etat.statut,
        derniereMaj: b.etat.derniereMaj,
        derniereTentative: b.etat.derniereTentative,
        ...(b.etat.erreur ? { erreur: b.etat.erreur } : {}),
      },
    ];
  });
}

/** Fichier servi pour une URL `webaios-bloc:` : seulement `<blocs>/<id>/index.html`, sinon null. */
export function cheminBloc(blocs: string, url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== `${SCHEMA_BLOC}:` || !ID_BLOC.test(u.hostname) || u.pathname !== "/index.html") return null;
  return join(blocs, u.hostname, "index.html");
}

/** Les liens d'un bloc s'ouvrent hors de l'iframe (dans un onglet, voir index.ts). */
export function avecBase(html: string): string {
  const base = '<base target="_blank">';
  const tete = /<head\b[^>]*>/i.exec(html) ?? /^\s*<!doctype[^>]*>/i.exec(html);
  if (!tete) return base + html;
  const fin = tete.index + tete[0].length;
  return html.slice(0, fin) + base + html.slice(fin);
}

export async function lireBlocsAffiches(n: Pick<Noyau, "lireAccueil">): Promise<BlocAffiche[]> {
  const etat = await n.lireAccueil();
  const mtimes: Record<string, number> = {};
  for (const b of etat.blocs) {
    if (!("cheminHtml" in b) || !b.cheminHtml) continue;
    try {
      mtimes[b.id] = Math.round((await stat(b.cheminHtml)).mtimeMs);
    } catch {
      // index.html supprimé entre-temps : la prochaine lecture le dira
    }
  }
  return versBlocsAffiches(etat, mtimes);
}

/** L'utilisateur a déplacé un bloc : nouvel ordre dans disposition.json (écriture atomique). Les ids inconnus sont ignorés. */
export async function ordonnerBlocs(c: CheminsEspace, ordre: string[]): Promise<void> {
  const connus = [...new Set(ordre)].filter((id) => ID_BLOC.test(id) && existsSync(join(c.blocs, id)));
  const temporaire = `${c.disposition}.${process.pid}.tmp`;
  await writeFile(temporaire, JSON.stringify({ ordre: connus }, null, 2));
  await rename(temporaire, c.disposition);
}

/** L'utilisateur retire un bloc : son dossier part dans accueil/.corbeille (rien n'est détruit). */
export async function retirerBloc(c: CheminsEspace, id: string): Promise<void> {
  if (!ID_BLOC.test(id)) throw new Error(`id de bloc invalide : ${id}`);
  let ordre: string[] = [];
  try {
    const lu = JSON.parse(await readFile(c.disposition, "utf8")) as { ordre?: unknown };
    if (Array.isArray(lu.ordre)) ordre = lu.ordre.filter((x): x is string => typeof x === "string");
  } catch {
    // pas encore de disposition : rien à retirer de l'ordre
  }
  const corbeille = join(c.accueil, ".corbeille");
  await mkdir(corbeille, { recursive: true });
  await rename(join(c.blocs, id), join(corbeille, `${id}-${Date.now()}`));
  await ordonnerBlocs(c, ordre.filter((x) => x !== id));
}

/** Avant `app.whenReady` : le schéma doit être standard pour que les URL aient un hôte (l'id du bloc). */
export function enregistrerSchemaBloc(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: SCHEMA_BLOC, privileges: { standard: true, secure: true } }]);
}

/** Sert les index.html des blocs à l'interface. `blocs` : dossier des blocs, null tant que le noyau n'est pas prêt. */
export function servirBlocs(blocs: () => string | null): void {
  const introuvable = () => new Response("", { status: 404 });
  protocol.handle(SCHEMA_BLOC, async (requete) => {
    const dossier = blocs();
    const chemin = dossier && cheminBloc(dossier, requete.url);
    if (!chemin) return introuvable();
    try {
      const html = await readFile(chemin, "utf8");
      return new Response(avecBase(html), {
        headers: { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": CSP_BLOC },
      });
    } catch {
      return introuvable();
    }
  });
}

/**
 * Seules les vues web des blocs d'app peuvent s'attacher à l'interface : http(s), session web, bac à sable, aucun
 * preload. `brancher` reçoit chaque vue attachée (ses nouvelles fenêtres vont aux onglets).
 */
export function protegerWebviews(ui: WebContents, brancher: (vue: WebContents) => void): void {
  ui.on("will-attach-webview", (e, prefs, params) => {
    delete prefs.preload;
    prefs.nodeIntegration = false;
    prefs.contextIsolation = true;
    prefs.sandbox = true;
    if (!/^https?:\/\//.test(params.src ?? "") || params.partition !== PARTITION_WEB) e.preventDefault();
  });
  ui.on("did-attach-webview", (_e, vue) => brancher(vue));
}
