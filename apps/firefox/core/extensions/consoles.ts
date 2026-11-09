import type { ConsolePourAgent, MessageConsole } from "@webaios/noyau";

/** Messages kept per extension: the oldest drop. */
export const CONSOLE_MAX = 500;
/** `PLANTAGES_MAX` crashes in `FENETRE_PLANTAGES_MS`: the extension is disabled everywhere. */
export const PLANTAGES_MAX = 3;
export const FENETRE_PLANTAGES_MS = 60_000;

/**
 * A recorded message: `onglet` for a content script (was the tab view it comes from readable by the agent
 * when it was written?), null for the service worker and the extension's pages.
 */
interface Entree {
  m: MessageConsole;
  onglet: { lisible: boolean } | null;
}

/** What the agent can see of a console: the registry (« has run » flag) and the unlock decide with it. */
export interface FiltreAgent {
  depuis?: number;
  debloquee: boolean;
  /** The extension ran in a tab the agent cannot read (registry flag, never reset). */
  tourneIllisible: boolean;
  /** The extension has a right that observes tabs or navigation: its service worker and pages, always masked. */
  observateur: boolean;
}

/**
 * Consoles of the extensions (service worker, `chrome-extension://` pages, content scripts in tabs), by Chromium
 * id, in memory, and count of their crashes (extension pages gone other than `clean-exit`, `loadExtension`
 * failures). What is recorded comes from the extension: data, displayed as text, never an instruction.
 *
 * For the agent (spec §5, filtered console), `pourAgent` removes the messages of tabs it could not read; those
 * of the service worker and pages, all of them if the extension ran in such a tab (`tourneIllisible`) or if it has a
 * right that observes tabs or navigation (`observateur`). Decided at read time, never at write time: a message
 * kept and then written later does not pass. The user (Extensions page) sees everything.
 */
export class ConsolesExtensions {
  private consoles = new Map<string, Entree[]>();
  private plantages = new Map<string, number[]>();

  constructor(
    private readonly o: {
      /** `PLANTAGES_MAX` crashes within `FENETRE_PLANTAGES_MS`. */
      surPlantages(idChrome: string): void;
    },
  ) {}

  /** `onglet`: the message comes from a content script in a tab view, readable or not by the agent. */
  noter(idChrome: string, m: MessageConsole, onglet?: { lisible: boolean }): void {
    let liste = this.consoles.get(idChrome);
    if (!liste) this.consoles.set(idChrome, (liste = []));
    liste.push({ m, onglet: onglet ? { lisible: onglet.lisible } : null });
    if (liste.length > CONSOLE_MAX) liste.splice(0, liste.length - CONSOLE_MAX);
  }

  /** The kept messages (copy), those with timestamp ≥ `depuis` if given: all (Extensions page). */
  messages(idChrome: string, depuis?: number): MessageConsole[] {
    const liste = (this.consoles.get(idChrome) ?? []).map((e) => e.m);
    return depuis === undefined ? liste : liste.filter((m) => m.horodatage >= depuis);
  }

  /** The texts of the kept `error`-level messages: all (Extensions page). */
  erreurs(idChrome: string): string[] {
    return (this.consoles.get(idChrome) ?? []).filter((e) => e.m.niveau === "error").map((e) => e.m.texte);
  }

  /** What the agent sees of the console (copy), those with timestamp ≥ `depuis` if given. */
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

  /** The texts of the `error`-level messages the agent can see (same filter as `pourAgent`). */
  erreursPourAgent(idChrome: string, f: FiltreAgent): string[] {
    return this.pourAgent(idChrome, f).messages.filter((m) => m.niveau === "error").map((m) => m.texte);
  }

  /**
   * A crash at `horodatage` (ms): at the `PLANTAGES_MAX`-th within `FENETRE_PLANTAGES_MS` (bounds included), the callback
   * is called once and the count restarts from zero.
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

  /** The extension is deleted or re-enabled: its console and its crashes are forgotten. */
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
