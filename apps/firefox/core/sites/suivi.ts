import { changeUrl, readUrlState, findUrl, type DeclarationSite, type UrlState } from "@webaios/noyau";
import { INTERVALLE_SUIVI_MS } from "../../shared/sites";

export type ResultatSuivi = { t: "change"; domaine: string; etat: UrlState } | { t: "introuvable" } | { t: "inchangee" } | { t: "trop-tot" };

/** The host of an address, lowercase and without a trailing dot; "" if it is unreadable. */
function hoteDe(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/\.+$/, "");
  } catch {
    return "";
  }
}

/**
 * Tracking of a site app's address: when the site no longer answers, the reference page (public, hostile)
 * is read to find the new domain. At most one read per `INTERVALLE_SUIVI_MS` and per app, whether it
 * succeeded or not (a click in a loop reads nothing more). Nothing changes without a valid link according to `trouverAdresse`.
 */
export class SuiviAdresse {
  /** Last read started, per app. */
  private readonly dernieres = new Map<string, number>();

  constructor(
    private readonly o: {
      /** The links of the reference page, read without cookies or profile. */
      lireLiens(page: string, signal?: AbortSignal): Promise<string[]>;
      dossierSites: string;
      adressesLocales: boolean;
      maintenant(): number;
    },
  ) {}

  /** The app is deleted: the next app with the same id restarts without a recent read. */
  oublier(id: string): void {
    this.dernieres.delete(id);
  }

  async chercher(id: string, d: DeclarationSite, signal?: AbortSignal): Promise<ResultatSuivi> {
    const suivi = d.suiviAdresse;
    if (!suivi) return { t: "introuvable" };
    const maintenant = this.o.maintenant();
    const derniere = this.dernieres.get(id);
    if (derniere !== undefined && maintenant - derniere < INTERVALLE_SUIVI_MS) return { t: "trop-tot" };
    // Noted before the read: a second request during it reads nothing.
    this.dernieres.set(id, maintenant);
    let liens: string[];
    try {
      liens = await this.o.lireLiens(suivi.page, signal);
      if (signal?.aborted) return { t: "introuvable" };
    } catch {
      return { t: "introuvable" };
    }
    const trouvee = findUrl(liens, { page: suivi.page, motif: suivi.motif, adressesLocales: this.o.adressesLocales });
    if (!trouvee) return { t: "introuvable" };
    if (signal?.aborted) return { t: "introuvable" };
    const courant = await readUrlState(this.o.dossierSites, id);
    // Cancelled during the re-reading of the state (app deletion): nothing is written.
    if (signal?.aborted) return { t: "introuvable" };
    const actuel = courant?.actuel ?? hoteDe(d.adresse);
    if (trouvee.hostname === actuel) return { t: "inchangee" };
    try {
      const etat = await changeUrl(this.o.dossierSites, id, d, trouvee.hostname);
      return { t: "change", domaine: etat.actuel, etat };
    } catch {
      return { t: "introuvable" };
    }
  }
}
