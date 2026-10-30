import type { MessageConsole } from "@webaios/noyau";

/** Messages gardés par extension : les plus anciens tombent. */
export const CONSOLE_MAX = 500;
/** `PLANTAGES_MAX` plantages en `FENETRE_PLANTAGES_MS` : l'extension est désactivée partout. */
export const PLANTAGES_MAX = 3;
export const FENETRE_PLANTAGES_MS = 60_000;

/**
 * Consoles des extensions (service worker et pages `chrome-extension://`), par id Chromium, en mémoire, et décompte de
 * leurs plantages (pages d'extension disparues hors `clean-exit`, échecs de `loadExtension`). Ce qui est noté vient de
 * l'extension : de la donnée, affichée en texte, jamais une consigne.
 */
export class ConsolesExtensions {
  private consoles = new Map<string, MessageConsole[]>();
  private plantages = new Map<string, number[]>();

  constructor(private readonly o: { /** `PLANTAGES_MAX` plantages en `FENETRE_PLANTAGES_MS`. */ surPlantages(idChrome: string): void }) {}

  noter(idChrome: string, m: MessageConsole): void {
    let liste = this.consoles.get(idChrome);
    if (!liste) this.consoles.set(idChrome, (liste = []));
    liste.push(m);
    if (liste.length > CONSOLE_MAX) liste.splice(0, liste.length - CONSOLE_MAX);
  }

  /** Les messages gardés (copie), ceux d'horodatage ≥ `depuis` si donné. */
  messages(idChrome: string, depuis?: number): MessageConsole[] {
    const liste = this.consoles.get(idChrome) ?? [];
    return depuis === undefined ? [...liste] : liste.filter((m) => m.horodatage >= depuis);
  }

  /** Les textes des messages de niveau `error` gardés. */
  erreurs(idChrome: string): string[] {
    return (this.consoles.get(idChrome) ?? []).filter((m) => m.niveau === "error").map((m) => m.texte);
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

/** Le niveau d'un message de console d'Electron (nombre 0–3 des service workers, ou nom des pages). */
export function niveauConsole(n: number | string): MessageConsole["niveau"] {
  if (n === 3 || n === "error") return "error";
  if (n === 2 || n === "warning") return "warn";
  if (n === 0 || n === "debug") return "debug";
  return "log";
}
