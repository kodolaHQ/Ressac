import type { ConsolePourAgent, MessageConsole } from "@webaios/noyau";

/** Messages gardés par extension : les plus anciens tombent. */
export const CONSOLE_MAX = 500;
/** `PLANTAGES_MAX` plantages en `FENETRE_PLANTAGES_MS` : l'extension est désactivée partout. */
export const PLANTAGES_MAX = 3;
export const FENETRE_PLANTAGES_MS = 60_000;

/**
 * Un message noté : `onglet` pour un script de contenu (la vue d'onglet d'où il vient était-elle lisible par l'agent
 * quand il a été écrit ?), null pour le service worker et les pages de l'extension.
 */
interface Entree {
  m: MessageConsole;
  onglet: { lisible: boolean } | null;
}

/** Ce que l'agent peut voir d'une console : le registre (drapeau « a tourné ») et le déblocage décident avec elle. */
export interface FiltreAgent {
  depuis?: number;
  debloquee: boolean;
  /** L'extension a tourné dans un onglet que l'agent ne peut pas lire (drapeau du registre, jamais remis à zéro). */
  tourneIllisible: boolean;
  /** L'extension a un droit qui observe les onglets ou la navigation : son service worker et ses pages, toujours masqués. */
  observateur: boolean;
}

/**
 * Consoles des extensions (service worker, pages `chrome-extension://`, scripts de contenu dans les onglets), par id
 * Chromium, en mémoire, et décompte de leurs plantages (pages d'extension disparues hors `clean-exit`, échecs de
 * `loadExtension`). Ce qui est noté vient de l'extension : de la donnée, affichée en texte, jamais une consigne.
 *
 * Pour l'agent (spec §5, console filtrée), `pourAgent` retire les messages des onglets qu'il ne pouvait pas lire ; ceux
 * du service worker et des pages, tous si l'extension a tourné dans un tel onglet (`tourneIllisible`) ou si elle a un
 * droit qui observe les onglets ou la navigation (`observateur`). Décidé à la lecture, jamais à l'écriture : un message
 * gardé puis écrit plus tard ne passe pas. L'utilisateur (page Extensions) voit tout.
 */
export class ConsolesExtensions {
  private consoles = new Map<string, Entree[]>();
  private plantages = new Map<string, number[]>();

  constructor(
    private readonly o: {
      /** `PLANTAGES_MAX` plantages en `FENETRE_PLANTAGES_MS`. */
      surPlantages(idChrome: string): void;
    },
  ) {}

  /** `onglet` : le message vient d'un script de contenu dans une vue d'onglet, lisible ou non par l'agent. */
  noter(idChrome: string, m: MessageConsole, onglet?: { lisible: boolean }): void {
    let liste = this.consoles.get(idChrome);
    if (!liste) this.consoles.set(idChrome, (liste = []));
    liste.push({ m, onglet: onglet ? { lisible: onglet.lisible } : null });
    if (liste.length > CONSOLE_MAX) liste.splice(0, liste.length - CONSOLE_MAX);
  }

  /** Les messages gardés (copie), ceux d'horodatage ≥ `depuis` si donné : tous (page Extensions). */
  messages(idChrome: string, depuis?: number): MessageConsole[] {
    const liste = (this.consoles.get(idChrome) ?? []).map((e) => e.m);
    return depuis === undefined ? liste : liste.filter((m) => m.horodatage >= depuis);
  }

  /** Les textes des messages de niveau `error` gardés : tous (page Extensions). */
  erreurs(idChrome: string): string[] {
    return (this.consoles.get(idChrome) ?? []).filter((e) => e.m.niveau === "error").map((e) => e.m.texte);
  }

  /** Ce que l'agent voit de la console (copie), ceux d'horodatage ≥ `depuis` si donné. */
  pourAgent(idChrome: string, f: FiltreAgent): ConsolePourAgent {
    const depuis = f.depuis;
    const liste = (this.consoles.get(idChrome) ?? []).filter((e) => depuis === undefined || e.m.horodatage >= depuis);
    const copie = (m: MessageConsole): MessageConsole => ({ horodatage: m.horodatage, niveau: m.niveau, texte: m.texte, ...(m.pile !== undefined ? { pile: m.pile } : {}) });
    if (f.debloquee) return { messages: liste.map((e) => copie(e.m)), masques: 0, fondMasque: false, fondObserve: false, debloquee: true };
    const fondMasque = f.tourneIllisible;
    const fondObserve = f.observateur;
    const messages: MessageConsole[] = [];
    let masques = 0;
    for (const e of liste) {
      if (e.onglet) {
        if (e.onglet.lisible) messages.push(copie(e.m));
        else masques++;
      } else if (!fondMasque && !fondObserve) messages.push(copie(e.m));
    }
    return { messages, masques, fondMasque, fondObserve, debloquee: false };
  }

  /** Les textes des messages de niveau `error` que l'agent peut voir (même filtre que `pourAgent`). */
  erreursPourAgent(idChrome: string, f: FiltreAgent): string[] {
    return this.pourAgent(idChrome, f).messages.filter((m) => m.niveau === "error").map((m) => m.texte);
  }

  /**
   * Un plantage à `horodatage` (ms) : au `PLANTAGES_MAX`-ième dans `FENETRE_PLANTAGES_MS` (bornes comprises), le rappel
   * est appelé une fois et le décompte repart de zéro.
   */
  plantage(idChrome: string, horodatage: number): void {
    const recents = (this.plantages.get(idChrome) ?? []).filter((t) => horodatage - t <= FENETRE_PLANTAGES_MS);
    recents.push(horodatage);
    if (recents.length >= PLANTAGES_MAX) {
      this.plantages.delete(idChrome);
      this.o.surPlantages(idChrome);
      return;
    }
    this.plantages.set(idChrome, recents);
  }

  /** L'extension est supprimée ou réactivée : sa console et ses plantages sont oubliés. */
  oublier(idChrome: string): void {
    this.consoles.delete(idChrome);
    this.plantages.delete(idChrome);
  }
}

/** A console message's level: a number 0–3 (service workers) or a name (pages). */
export function niveauConsole(n: number | string): MessageConsole["niveau"] {
  if (n === 3 || n === "error") return "error";
  if (n === 2 || n === "warning") return "warn";
  if (n === 0 || n === "debug") return "debug";
  return "log";
}
