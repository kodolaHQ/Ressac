import { CHEMIN_CONTENEUR } from "../chemins.js";
import type { BlocLu, ConfigBlocAgent } from "../accueil/blocs-anciens.js";

const HEURE = 3_600_000;
const SEUIL_LANCEMENT_H = 12;
const PERIODE_DEFAUT_H = 24;
const REESSAI_ERREUR_H = 1;

const age = (iso: string | null, maintenant: Date) => (iso ? maintenant.getTime() - Date.parse(iso) : Infinity);

/** Ids des blocs d'agent à rafraîchir maintenant (spec §7). */
export function blocsAEchoir(blocs: BlocLu[], maintenant: Date, o: { auLancement: boolean }): string[] {
  return blocs
    .filter((b) => {
      if (!("config" in b) || b.config.type !== "agent") return false;
      const periode = b.config.rafraichissement?.heures ?? PERIODE_DEFAUT_H;
      const seuil = (o.auLancement ? Math.min(SEUIL_LANCEMENT_H, periode) : periode) * HEURE;
      switch (b.etat.statut) {
        case "en-cours":
          return o.auLancement; // un lancement précédent a été interrompu
        case "erreur":
          return age(b.etat.derniereTentative, maintenant) >= REESSAI_ERREUR_H * HEURE;
        case "ok":
          return age(b.etat.derniereMaj, maintenant) >= seuil;
      }
    })
    .map((b) => b.id);
}

export function consigneVeille(id: string, config: ConfigBlocAgent): string {
  return [
    `Tu mets à jour le bloc « ${config.titre} » de la page d'accueil WebAiOs.`,
    `Consigne : ${config.consigne}`,
    `Écris le résultat complet dans ${CHEMIN_CONTENEUR}/accueil/blocs/${id}/index.html.nouveau en suivant le format décrit dans ${CHEMIN_CONTENEUR}/AGENTS.md. Ne modifie aucun autre fichier.`,
  ].join("\n");
}
