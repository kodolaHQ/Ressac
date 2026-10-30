import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { COMPOSANTS_INTEGRES, type DefinitionComposant } from "./catalogue.js";

// Les composants de l'agent : `<dossier>/<nom>/composant.json` + `composant.html`. Rien n'est exécuté ici ; les erreurs sont
// des textes fixes (le message du système citerait des chemins du Mac).

export const COMPOSANT_HTML_MAX = 256 * 1024;
const JSON_MAX = 64 * 1024;
const ERREUR_MAX = 300;
export const NOM_PROPRIETE = /^[a-zA-Z][a-zA-Z0-9_]{0,39}$/;
const NOM = /^[a-z0-9-]{1,40}$/;

export const DeclarationComposant = z
  .object({
    nom: z.string().regex(NOM),
    description: z.string().min(1).max(300),
    proprietes: z
      .record(
        z.string().regex(NOM_PROPRIETE),
        z.object({
          genre: z.enum(["reference", "champ", "texte", "nombre", "case"]),
          description: z.string().min(1).max(200),
          requis: z.boolean().default(false),
        }).strict(),
      )
      .refine((r) => Object.keys(r).length <= 12, "12 propriétés au plus"),
  })
  .strict();
export type DeclarationComposant = z.infer<typeof DeclarationComposant>;

const NOMS_INTEGRES = new Set(COMPOSANTS_INTEGRES.map((c) => c.nom));

async function lireFichier(fichier: string, nom: string, max: number, absent: string): Promise<{ texte: string } | { erreur: string }> {
  let s;
  try {
    s = await lstat(fichier);
  } catch {
    return { erreur: absent };
  }
  if (!s.isFile()) return { erreur: `${nom} n'est pas un fichier ordinaire` };
  if (s.size > max) return { erreur: `${nom} dépasse ${max / 1024} Ko` };
  try {
    return { texte: await readFile(fichier, "utf8") };
  } catch {
    return { erreur: `${nom} illisible` };
  }
}

async function lireUn(dossier: string, nom: string): Promise<DefinitionComposant | string> {
  const json = await lireFichier(join(dossier, nom, "composant.json"), "composant.json", JSON_MAX, "composant.json absent");
  if ("erreur" in json) return json.erreur;
  let brut: unknown;
  try {
    brut = JSON.parse(json.texte);
  } catch {
    return "composant.json illisible (pas du JSON valide)";
  }
  // zod ignore en silence une clé « __proto__ » : on regarde les clés brutes avant.
  const props = (brut as { proprietes?: unknown } | null)?.proprietes;
  if (props && typeof props === "object" && Object.keys(props).some((k) => !NOM_PROPRIETE.test(k))) {
    return "composant.json invalide : proprietes : nom de propriété non valide";
  }
  const r = DeclarationComposant.safeParse(brut);
  if (!r.success) {
    const i = r.error.issues[0]!;
    const t = `composant.json invalide : ${[...i.path, i.message].join(" : ")}`;
    return t.length > ERREUR_MAX ? t.slice(0, ERREUR_MAX - 1) + "…" : t;
  }
  const d = r.data;
  if (d.nom !== nom) return "composant.json : le nom doit être celui du dossier";
  if (NOMS_INTEGRES.has(d.nom)) return "composant.json : ce nom est celui d'un composant intégré";
  const html = await lireFichier(join(dossier, nom, "composant.html"), "composant.html", COMPOSANT_HTML_MAX, "composant.html absent");
  if ("erreur" in html) return html.erreur;
  return { nom: d.nom, description: d.description, proprietes: d.proprietes, origine: "agent" };
}

/** Les composants de l'agent, triés par nom ; un composant cassé est signalé, il n'empêche pas de lire les autres. */
export async function lireComposantsAgent(dossier: string): Promise<{ valides: DefinitionComposant[]; invalides: { nom: string; erreur: string }[] }> {
  let noms: string[];
  try {
    // `isDirectory` est faux pour un lien symbolique : un lien vers un dossier est ignoré.
    noms = (await readdir(dossier, { withFileTypes: true })).filter((e) => e.isDirectory() && NOM.test(e.name)).map((e) => e.name).sort();
  } catch {
    return { valides: [], invalides: [] };
  }
  const valides: DefinitionComposant[] = [];
  const invalides: { nom: string; erreur: string }[] = [];
  for (const nom of noms) {
    const r = await lireUn(dossier, nom);
    if (typeof r === "string") invalides.push({ nom, erreur: r });
    else valides.push(r);
  }
  return { valides, invalides };
}
