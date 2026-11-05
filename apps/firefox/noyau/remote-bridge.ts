import {
  OngletIntrouvable,
  OngletPrive,
  OutilsDevOccupes,
  ProfilRefuse,
  type HistoriqueNavigateur,
  type OngletInfo,
  type OptionsLecturePage,
  type OutilsDevNavigateur,
  type OutilsDevProprietaire,
  type PageLue,
  type PontNavigateur,
} from "../../../packages/noyau/src/index.ts";
import type { Historique } from "../../navigateur/src/main/historique.ts";
import type { Rpc } from "../shared/rpc.ts";

/** The noyau's browser bridge, answered by Firefox over JSON-RPC. Only the private-tab mirror lives here. */
export class RemoteBridge implements PontNavigateur {
  private prives = new Set<string>();
  private actifPrive = false;

  /** The agent's history tools; absent, it has none. Same mapping as Electron's PontElectron. */
  readonly historique?: HistoriqueNavigateur;

  constructor(
    private readonly rpc: Rpc,
    h?: Pick<Historique, "rechercherPourAgent" | "texteRetenu">,
  ) {
    if (h)
      this.historique = {
        // The noyau checked the ISO dates and bounded the limit.
        chercher: async ({ requete, depuis, jusqua, limite }) =>
          h.rechercherPourAgent({
            requete,
            limite,
            ...(depuis !== undefined ? { depuis: new Date(depuis) } : {}),
            ...(jusqua !== undefined ? { jusqua: new Date(jusqua) } : {}),
          }),
        lire: async (url) => h.texteRetenu(url),
      };
  }

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
      if (x.name === "OutilsDevOccupes") throw new OutilsDevOccupes();
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

  /**
   * The tab dev tools, run by Firefox (chrome/store/devtools.ts). Only an owner's are usable: Firefox keeps its
   * attachments across noyau starts, a new owner revokes the previous one.
   */
  readonly outilsDev: OutilsDevNavigateur = {
    // Without an owner's token Firefox refuses every call.
    ...this.devTools(Promise.resolve("")),
    proprietaire: () => {
      const token = this.call<{ token: string }>("outilsDev.owner", []).then((r) => r.token);
      token.catch(() => {});
      return { ...this.devTools(token), liberer: () => void token.then((t) => this.rpc.notify("outilsDev.release", [t]), () => {}) };
    },
  };

  /** Each method sends its arguments with the owner's token; a trailing AbortSignal cancels the request instead. */
  private devTools(token: Promise<string>): Omit<OutilsDevProprietaire, "liberer"> {
    const f =
      (method: keyof OutilsDevNavigateur) =>
      async (...a: unknown[]): Promise<any> => {
        const signal = a.at(-1) instanceof AbortSignal ? (a.pop() as AbortSignal) : undefined;
        return this.call("outilsDev.call", [await token, method, a], signal);
      };
    return {
      attacher: f("attacher"),
      detacher: f("detacher"),
      console: f("console"),
      reseau: f("reseau"),
      corps: f("corps"),
      profiler: f("profiler"),
      instantaneMemoire: f("instantaneMemoire"),
      executer: f("executer"),
      recharger: f("recharger"),
    };
  }

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
