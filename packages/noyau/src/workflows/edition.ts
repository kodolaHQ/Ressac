import { readFile, realpath, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import { ecrireAtomique } from "./executions.js";
import { existe, lireBrutWorkflow } from "./lire.js";
import { avecMemoire, ecrireMemoire, empreinteParametres, jsonCanonique, lireMemoire } from "./memoire.js";
import { TAILLE_MAX_WORKFLOW } from "./schema.js";
import { erreurWorkflow, validerWorkflow, workflowImplicite, type ResultatValidation, type WorkflowValide } from "./valider.js";

// Le constructeur ne fait que lire et écrire `workflow.json` et les `.mjs` comme du texte : rien n'est exécuté ici.

export const CODE_MAX_OCTETS = 256 * 1024;
export const NOM_CODE = /^[a-z0-9-]+\.mjs$/;

const WIDGET_INTROUVABLE = "Widget introuvable";

export type LectureBrouillon = {
  origine: "fichier" | "implicite";
  /** null : pas du JSON, illisible, plus de 256 Ko, ou lien qui sort du dossier. */
  brut: unknown | null;
  validation: { ok: true } | { ok: false; erreur: string; bloc?: string };
};

export type ResultatEnregistrement =
  | { ok: true; ecrit: boolean; memoireEffacee: string[] }
  | { ok: false; erreur: string; bloc?: string };

const resume = (r: ResultatValidation): LectureBrouillon["validation"] => (r.ok ? { ok: true } : { ok: false, erreur: r.erreur, ...(r.bloc === undefined ? {} : { bloc: r.bloc }) });

/** Le fichier existe (lien seulement vérifié par son nom) et son vrai chemin reste dans le dossier. */
async function dansLeDossier(dossier: string, nom: string): Promise<boolean> {
  try {
    const [racine, reel] = await Promise.all([realpath(dossier), realpath(join(dossier, nom))]);
    return reel.startsWith(racine + sep);
  } catch {
    return false;
  }
}

async function dossierExiste(dossier: string): Promise<boolean> {
  try {
    return (await stat(dossier)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Ce que le constructeur ouvre : `workflow.json` même invalide, sinon l'implicite d'un `recolte.mjs`, sinon null.
 * N'écrit rien.
 */
export async function lireBrouillon(dossierFichiers: string): Promise<LectureBrouillon | null> {
  if (await existe(join(dossierFichiers, "workflow.json"))) {
    const lu = await lireBrutWorkflow(dossierFichiers);
    if ("erreur" in lu) return { origine: "fichier", brut: null, validation: resume(erreurWorkflow(lu.erreur)) };
    return { origine: "fichier", brut: lu.brut, validation: resume(validerWorkflow(lu.brut)) };
  }
  if (await existe(join(dossierFichiers, "recolte.mjs"))) {
    const brut = workflowImplicite();
    return { origine: "implicite", brut, validation: resume(validerWorkflow(brut)) };
  }
  return null;
}

/** Le workflow valide en place : le fichier s'il est valide, sinon l'implicite d'un `recolte.mjs`, sinon aucun. */
async function workflowActuel(dossier: string): Promise<WorkflowValide | null> {
  const l = await lireBrouillon(dossier);
  if (!l || l.brut === null) return null;
  const r = validerWorkflow(l.brut);
  return r.ok ? r.valide : null;
}

/**
 * Enregistre `workflow.json` (écriture atomique) si le workflow est valide, si les fichiers de ses blocs `code`
 * existent et s'il diffère de l'actuel. Efface d'abord la mémoire des blocs dont les paramètres changent.
 */
export async function enregistrerWorkflow(o: { dossierFichiers: string; dossierDonnees: string; brut: unknown }): Promise<ResultatEnregistrement> {
  const r = validerWorkflow(o.brut);
  if (!r.ok) return { ok: false, erreur: r.erreur, ...(r.bloc === undefined ? {} : { bloc: r.bloc }) };
  if (!(await dossierExiste(o.dossierFichiers))) return { ok: false, erreur: WIDGET_INTROUVABLE };

  for (const b of r.valide.workflow.blocs) {
    if (b.type !== "code") continue;
    const source = String(b.parametres.source);
    if (!(await existe(join(o.dossierFichiers, source)))) return { ok: false, erreur: `Non enregistré : fichier ${source} absent`, bloc: b.id };
  }

  const texte = JSON.stringify(o.brut, null, 2) + "\n";
  if (Buffer.byteLength(texte) > TAILLE_MAX_WORKFLOW) return { ok: false, erreur: `Workflow trop gros : ${TAILLE_MAX_WORKFLOW / 1024} Ko au plus` };
  const cible = join(o.dossierFichiers, "workflow.json");
  if ((await existe(cible)) && !(await dansLeDossier(o.dossierFichiers, "workflow.json"))) {
    return { ok: false, erreur: "workflow.json sort du dossier du widget" };
  }

  const avant = await workflowActuel(o.dossierFichiers);
  if (avant && jsonCanonique(avant.workflow) === jsonCanonique(r.valide.workflow)) return { ok: true, ecrit: false, memoireEffacee: [] };

  // La mémoire des blocs changés part avant l'écriture du workflow : une exécution qui lit le nouveau workflow lit
  // forcément la mémoire déjà effacée. Seules restent les entrées marquées des nouveaux réglages (une exécution qui a
  // déjà tourné avec eux) ; une entrée sans empreinte (d'avant les empreintes) part aussi.
  const memoireEffacee = avant
    ? await avecMemoire(o.dossierDonnees, async () => {
        const anciens = new Map(avant.workflow.blocs.map((b) => [b.id, b]));
        const memoire = await lireMemoire(o.dossierDonnees);
        const effaces: string[] = [];
        for (const b of r.valide.workflow.blocs) {
          const ancien = anciens.get(b.id);
          const entree = memoire[b.id];
          if (!ancien || ancien.type !== b.type || !entree) continue;
          const nouvelle = empreinteParametres(b.parametres);
          if (empreinteParametres(ancien.parametres) !== nouvelle && entree.empreinte !== nouvelle) {
            delete memoire[b.id];
            effaces.push(b.id);
          }
        }
        if (effaces.length > 0) await ecrireMemoire(o.dossierDonnees, memoire);
        return effaces;
      })
    : [];

  await ecrireAtomique(cible, texte);
  return { ok: true, ecrit: true, memoireEffacee };
}

const NOM_INVALIDE = "Nom de fichier invalide";
const TROP_GROS = `Fichier trop gros : ${CODE_MAX_OCTETS / 1024} Ko au plus`;
const SORT_DU_DOSSIER = "Le fichier sort du dossier du widget";

export async function lireCode(dossierFichiers: string, nom: string): Promise<{ texte: string } | { absent: true } | { erreur: string }> {
  if (!NOM_CODE.test(nom)) return { erreur: NOM_INVALIDE };
  const chemin = join(dossierFichiers, nom);
  if (!(await existe(chemin))) return { absent: true };
  try {
    if (!(await dansLeDossier(dossierFichiers, nom))) return { erreur: SORT_DU_DOSSIER };
    if ((await stat(chemin)).size > CODE_MAX_OCTETS) return { erreur: TROP_GROS };
    return { texte: await readFile(chemin, "utf8") };
  } catch {
    return { erreur: "Fichier illisible" };
  }
}

/** Écrit un `.mjs` du widget tel quel : son contenu n'est ni contrôlé ni exécuté. */
export async function enregistrerCode(dossierFichiers: string, nom: string, texte: string): Promise<{ ok: true } | { ok: false; erreur: string }> {
  if (!NOM_CODE.test(nom)) return { ok: false, erreur: NOM_INVALIDE };
  if (Buffer.byteLength(texte) > CODE_MAX_OCTETS) return { ok: false, erreur: TROP_GROS };
  if (!(await dossierExiste(dossierFichiers))) return { ok: false, erreur: WIDGET_INTROUVABLE };
  const chemin = join(dossierFichiers, nom);
  if ((await existe(chemin)) && !(await dansLeDossier(dossierFichiers, nom))) return { ok: false, erreur: SORT_DU_DOSSIER };
  try {
    await ecrireAtomique(chemin, texte);
  } catch {
    return { ok: false, erreur: "Écriture impossible" };
  }
  return { ok: true };
}
