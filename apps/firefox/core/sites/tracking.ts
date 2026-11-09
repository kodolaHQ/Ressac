import { changeUrl, readUrlState, findUrl, type DeclarationSite, type UrlState } from "@webaios/kernel";
import { TRACKING_INTERVAL_MS } from "../../shared/sites";

export type TrackingResult = { t: "change"; domaine: string; etat: UrlState } | { t: "introuvable" } | { t: "inchangee" } | { t: "trop-tot" };

/** The host of an address, lowercase and without a trailing dot; "" if it is unreadable. */
function hostOf(url: string): string {
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
export class UrlTracking {
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

  async chercher(id: string, d: DeclarationSite, signal?: AbortSignal): Promise<TrackingResult> {
    const tracking = d.suiviAdresse;
    if (!tracking) return { t: "introuvable" };
    const now = this.o.maintenant();
    const last = this.dernieres.get(id);
    if (last !== undefined && now - last < TRACKING_INTERVAL_MS) return { t: "trop-tot" };
    // Noted before the read: a second request during it reads nothing.
    this.dernieres.set(id, now);
    let liens: string[];
    try {
      liens = await this.o.lireLiens(tracking.page, signal);
      if (signal?.aborted) return { t: "introuvable" };
    } catch {
      return { t: "introuvable" };
    }
    const found = findUrl(liens, { page: tracking.page, motif: tracking.motif, adressesLocales: this.o.adressesLocales });
    if (!found) return { t: "introuvable" };
    if (signal?.aborted) return { t: "introuvable" };
    const courant = await readUrlState(this.o.dossierSites, id);
    // Cancelled during the re-reading of the state (app deletion): nothing is written.
    if (signal?.aborted) return { t: "introuvable" };
    const current = courant?.actuel ?? hostOf(d.adresse);
    if (found.hostname === current) return { t: "inchangee" };
    try {
      const state = await changeUrl(this.o.dossierSites, id, d, found.hostname);
      return { t: "change", domaine: state.actuel, etat: state };
    } catch {
      return { t: "introuvable" };
    }
  }
}
