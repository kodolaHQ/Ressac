import { changeUrl, readUrlState, findUrl, type DeclarationSite, type UrlState } from "@webaios/kernel";
import { TRACKING_INTERVAL_MS } from "../../shared/sites";

export type TrackingResult = { t: "change"; domain: string; state: UrlState } | { t: "introuvable" } | { t: "inchangee" } | { t: "trop-tot" };

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
 * is read to find the new domain. At most one read per `TRACKING_INTERVAL_MS` and per app, whether it
 * succeeded or not (a click in a loop reads nothing more). Nothing changes without a valid link according to `findUrl`.
 */
export class UrlTracking {
  /** Last read started, per app. */
  private readonly lasts = new Map<string, number>();

  constructor(
    private readonly o: {
      /** The links of the reference page, read without cookies or profile. */
      readLinks(page: string, signal?: AbortSignal): Promise<string[]>;
      sitesFolder: string;
      localAddresses: boolean;
      now(): number;
    },
  ) {}

  /** The app is deleted: the next app with the same id restarts without a recent read. */
  forget(id: string): void {
    this.lasts.delete(id);
  }

  async find(id: string, d: DeclarationSite, signal?: AbortSignal): Promise<TrackingResult> {
    const tracking = d.urlTracking;
    if (!tracking) return { t: "introuvable" };
    const now = this.o.now();
    const last = this.lasts.get(id);
    if (last !== undefined && now - last < TRACKING_INTERVAL_MS) return { t: "trop-tot" };
    // Noted before the read: a second request during it reads nothing.
    this.lasts.set(id, now);
    let liens: string[];
    try {
      liens = await this.o.readLinks(tracking.page, signal);
      if (signal?.aborted) return { t: "introuvable" };
    } catch {
      return { t: "introuvable" };
    }
    const found = findUrl(liens, { page: tracking.page, pattern: tracking.pattern, localAddresses: this.o.localAddresses });
    if (!found) return { t: "introuvable" };
    if (signal?.aborted) return { t: "introuvable" };
    const currentUrl = await readUrlState(this.o.sitesFolder, id);
    // Cancelled during the re-reading of the state (app deletion): nothing is written.
    if (signal?.aborted) return { t: "introuvable" };
    const current = currentUrl?.current ?? hostOf(d.url);
    if (found.hostname === current) return { t: "inchangee" };
    try {
      const state = await changeUrl(this.o.sitesFolder, id, d, found.hostname);
      return { t: "change", domain: state.current, state: state };
    } catch {
      return { t: "introuvable" };
    }
  }
}
