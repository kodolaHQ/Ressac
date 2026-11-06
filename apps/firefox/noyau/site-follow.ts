// Copy of Electron's main/sites/suivi.ts, body unchanged (test/sites-host.test.ts compares them): Node cannot load that
// file under tsx (a CommonJS package whose "../../commun/sites" import does not resolve), so the host imports this one.
import { changerAdresse, lireEtatAdresse, trouverAdresse, type DeclarationSite, type EtatAdresse } from "../../../packages/noyau/src/index.ts";
import { INTERVALLE_SUIVI_MS } from "../../navigateur/src/commun/sites.ts";

export type ResultatSuivi = { t: "change"; domaine: string; etat: EtatAdresse } | { t: "introuvable" } | { t: "inchangee" } | { t: "trop-tot" };

/** L'hôte d'une adresse, en minuscules et sans point final ; "" si elle est illisible. */
function hoteDe(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/\.+$/, "");
  } catch {
    return "";
  }
}

/**
 * Le suivi de l'adresse d'une appli de site : quand le site ne répond plus, la page de référence (publique, hostile)
 * est lue pour y trouver le nouveau domaine. Au plus une lecture par `INTERVALLE_SUIVI_MS` et par appli, qu'elle ait
 * réussi ou non (un clic en boucle ne lit rien de plus). Rien ne change sans lien valable selon `trouverAdresse`.
 */
export class SuiviAdresse {
  /** Dernière lecture commencée, par appli. */
  private readonly dernieres = new Map<string, number>();

  constructor(
    private readonly o: {
      /** Les liens de la page de référence, lus sans cookies ni profil. */
      lireLiens(page: string, signal?: AbortSignal): Promise<string[]>;
      dossierSites: string;
      adressesLocales: boolean;
      maintenant(): number;
    },
  ) {}

  /** L'appli est supprimée : la prochaine appli au même id repart sans lecture récente. */
  oublier(id: string): void {
    this.dernieres.delete(id);
  }

  async chercher(id: string, d: DeclarationSite, signal?: AbortSignal): Promise<ResultatSuivi> {
    const suivi = d.suiviAdresse;
    if (!suivi) return { t: "introuvable" };
    const maintenant = this.o.maintenant();
    const derniere = this.dernieres.get(id);
    if (derniere !== undefined && maintenant - derniere < INTERVALLE_SUIVI_MS) return { t: "trop-tot" };
    // Noté avant la lecture : une seconde demande pendant celle-ci ne lit rien.
    this.dernieres.set(id, maintenant);
    let liens: string[];
    try {
      liens = await this.o.lireLiens(suivi.page, signal);
      if (signal?.aborted) return { t: "introuvable" };
    } catch {
      return { t: "introuvable" };
    }
    const trouvee = trouverAdresse(liens, { page: suivi.page, motif: suivi.motif, adressesLocales: this.o.adressesLocales });
    if (!trouvee) return { t: "introuvable" };
    if (signal?.aborted) return { t: "introuvable" };
    const courant = await lireEtatAdresse(this.o.dossierSites, id);
    // Annulée pendant la relecture de l'état (suppression de l'appli) : rien n'est écrit.
    if (signal?.aborted) return { t: "introuvable" };
    const actuel = courant?.actuel ?? hoteDe(d.adresse);
    if (trouvee.hostname === actuel) return { t: "inchangee" };
    try {
      const etat = await changerAdresse(this.o.dossierSites, id, d, trouvee.hostname);
      return { t: "change", domaine: etat.actuel, etat };
    } catch {
      return { t: "introuvable" };
    }
  }
}
