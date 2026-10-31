import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { ecrireAtomique } from "../workflows/executions.js";
import { retirerAccordSite } from "./accords.js";
import { domainesEffectifs, type EtatAdresse } from "./adresses.js";
import { ID_SITE, type DeclarationSite } from "./schemas.js";

export type { EtatAdresse };

const Etat = z.object({
  actuel: z.string().min(1).max(253),
  anciens: z.array(z.string().max(253)).max(100),
  depuis: z.string().nullable(),
});

function verifierId(id: string): void {
  if (!ID_SITE.test(id)) throw new Error(`id d'appli de site invalide : ${id}`);
}

const fichierAdresse = (dossierSites: string, id: string) => join(dossierSites, id, "adresse.json");

/** `<dossierSites>/<id>/adresse.json` ; absent ou abîmé : null (le site garde ses domaines déclarés). */
export async function lireEtatAdresse(dossierSites: string, id: string): Promise<EtatAdresse | null> {
  verifierId(id);
  try {
    const r = Etat.safeParse(JSON.parse(await readFile(fichierAdresse(dossierSites, id), "utf8")));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

const ANCIENS_MAX = 100;
const files = new Map<string, Promise<unknown>>();

/** Une opération à la fois par appli (changement d'adresse, suppression). */
function enFile<T>(cle: string, travail: () => Promise<T>): Promise<T> {
  const precedente = files.get(cle) ?? Promise.resolve();
  const suivante = precedente.catch(() => {}).then(travail);
  files.set(cle, suivante);
  void suivante.finally(() => {
    if (files.get(cle) === suivante) files.delete(cle);
  }).catch(() => {});
  return suivante;
}

/**
 * Le site a changé de domaine : `nouveau` devient l'actuel, l'ancien actuel (à défaut l'hôte de l'adresse déclarée)
 * rejoint les anciens sans doublon. Les écritures d'un même site se font l'une après l'autre.
 */
export function changerAdresse(dossierSites: string, id: string, d: DeclarationSite, nouveau: string): Promise<EtatAdresse> {
  verifierId(id);
  const cle = fichierAdresse(dossierSites, id);
  return enFile(join(dossierSites, id), async () => {
    const [propre] = domainesEffectifs({ ...d, domaines: [] }, { actuel: nouveau, anciens: [], depuis: null });
    if (!propre) throw new Error(`domaine invalide : ${nouveau}`);
    const courant = await lireEtatAdresse(dossierSites, id);
    let avant: string;
    try {
      avant = new URL(d.adresse).hostname.toLowerCase().replace(/\.+$/, "");
    } catch {
      avant = d.domaines[0] ?? "";
    }
    const actuel = courant?.actuel ?? avant;
    const anciens = courant?.anciens ?? [];
    if (propre === actuel) return courant ?? { actuel, anciens, depuis: null };
    const etat: EtatAdresse = {
      actuel: propre,
      anciens: [...new Set([...anciens, actuel])].filter((x) => x && x !== propre).slice(-ANCIENS_MAX),
      depuis: new Date().toISOString(),
    };
    await ecrireAtomique(cle, JSON.stringify(etat, null, 2));
    return etat;
  });
}

/** Oublie ce que WebAiOs retient d'une appli : mémoire, adresse (sous `<profil>/sites/<id>/`) et accord. */
export async function supprimerDonneesSite(profil: string, id: string): Promise<void> {
  verifierId(id);
  const dossierSites = join(profil, "sites");
  await enFile(join(dossierSites, id), () => rm(join(dossierSites, id), { recursive: true, force: true }));
  await retirerAccordSite(profil, id);
}
