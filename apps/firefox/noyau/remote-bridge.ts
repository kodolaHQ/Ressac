import { OngletIntrouvable, OngletPrive, ProfilRefuse, type OngletInfo, type OptionsLecturePage, type PageLue, type PontNavigateur } from "../../../packages/noyau/src/index.ts";
import type { Rpc } from "../shared/rpc.ts";

/** The noyau's browser bridge, answered by Firefox over JSON-RPC. Only the private-tab mirror lives here. */
export class RemoteBridge implements PontNavigateur {
  private prives = new Set<string>();
  private actifPrive = false;

  constructor(private readonly rpc: Rpc) {}

  setPrivate(m: { prives: string[]; actifPrive: boolean }): void {
    this.prives = new Set(m.prives);
    this.actifPrive = m.actifPrive;
  }

  private async call<T>(method: string, params: unknown[], signal?: AbortSignal): Promise<T> {
    try {
      return await this.rpc.request<T>(method, params, signal);
    } catch (e) {
      // The noyau expects an aborted read to reject with the signal's own reason.
      if (signal?.aborted) throw signal.reason;
      const x = e as Error & { id?: string; profil?: string };
      if (x.name === "OngletIntrouvable") throw new OngletIntrouvable(x.id!);
      if (x.name === "OngletPrive") throw new OngletPrive(x.id!);
      if (x.name === "ProfilRefuse") throw new ProfilRefuse(x.profil!);
      throw e;
    }
  }

  ongletActif = () => this.call<OngletInfo | null>("ongletActif", []);
  listerOnglets = () => this.call<OngletInfo[]>("listerOnglets", []);
  lireTexte = (id: string) => this.call<{ texte: string; selection?: string }>("lireTexte", [id]);
  ouvrirOnglet = (url: string, espace?: string) => this.call<OngletInfo>("ouvrirOnglet", espace === undefined ? [url] : [url, espace]);
  naviguer = (id: string, url: string) => this.call<void | "en-attente">("naviguer", [id, url]);
  capturer = async (id: string) => Buffer.from(await this.call<string>("capturer", [id]), "base64");
  demanderAutorisation = (o: OngletInfo) => this.call<boolean>("demanderAutorisation", [o]);
  estPrive = (id: string) => this.prives.has(id);
  ongletActifPrive = () => this.actifPrive;

  lirePageInvisible = async (url: string, o: OptionsLecturePage): Promise<PageLue> => {
    // shortcut: no paced (changerHote) reads yet, workflows' web widgets fail until a later plan wires it.
    if (o.changerHote) throw new Error("Lecture ménagée pas encore disponible");
    const { signal, changerHote: _, ...options } = o;
    return this.call<PageLue>("lirePageInvisible", [url, options], signal);
  };

  lireHtmlInvisible = (url: string, o: { adressesLocales?: boolean; signal?: AbortSignal }) => {
    const { signal, ...options } = o;
    return this.call<{ url: string; html: string }>("lireHtmlInvisible", [url, options], signal);
  };
}
