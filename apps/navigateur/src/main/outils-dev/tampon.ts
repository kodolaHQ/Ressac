import { tronquer, type MessageConsole, type RequeteReseau } from "@webaios/noyau";

/** Valeur d'un argument de console ou d'une exception (Runtime.RemoteObject du protocole). */
interface ObjetDistant {
  type?: string;
  value?: unknown;
  unserializableValue?: string;
  description?: string;
}

interface Pile {
  callFrames?: { functionName?: string; url?: string; lineNumber?: number; columnNumber?: number }[];
  parent?: Pile;
}

const ORIGINE_EXTENSION = "chrome-extension://";

/** Une pile (parentes comprises) a un cadre dans un script d'extension. */
function pileDExtension(p: Pile | undefined): boolean {
  for (let n = 0; p && n < 50; p = p.parent, n++) if (p.callFrames?.some((c) => c.url?.startsWith(ORIGINE_EXTENSION))) return true;
  return false;
}

/** Texte d'une valeur distante : la chaîne telle quelle, le JSON d'une valeur sérialisée, sinon sa description. */
export function texteObjet(o: ObjetDistant): string {
  if (o.type === "undefined") return "undefined";
  if (o.value !== undefined) return typeof o.value === "string" ? o.value : JSON.stringify(o.value);
  return o.unserializableValue ?? o.description ?? String(o.type ?? "");
}

/** Pile au format de V8 (`    at f (url:ligne:colonne)`), lignes et colonnes comptées à partir de 1. */
export function textePile(p: Pile | undefined): string | undefined {
  const cadres = p?.callFrames ?? [];
  if (!cadres.length) return undefined;
  return cadres
    .map((c) => {
      const lieu = `${c.url ?? ""}:${(c.lineNumber ?? 0) + 1}:${(c.columnNumber ?? 0) + 1}`;
      return c.functionName ? `    at ${c.functionName} (${lieu})` : `    at ${lieu}`;
    })
    .join("\n");
}

const NIVEAUX_CONSOLE: Record<string, MessageConsole["niveau"]> = {
  warning: "warn",
  error: "error",
  assert: "error",
  info: "info",
  debug: "debug",
};

const NIVEAUX_JOURNAL: Record<string, MessageConsole["niveau"]> = {
  verbose: "debug",
  info: "info",
  warning: "warn",
  error: "error",
};

/** Horodatage du protocole (secondes, horloge monotone) → millisecondes. */
const ms = (secondes: number) => secondes * 1000;

/**
 * Console et réseau d'un onglet, tirés des événements du protocole des outils de développement (Chrome DevTools
 * Protocol). Pur : l'inspecteur lui passe les événements, il garde les plus récents.
 */
export class TamponOnglet {
  private messages: MessageConsole[] = [];
  /** Par id de requête, dans l'ordre d'envoi. */
  private readonly requetes = new Map<string, RequeteReseau>();
  /** Début de chaque requête, sur l'horloge monotone du protocole (pour la durée). */
  private readonly debuts = new Map<string, number>();
  private readonly maxConsole: number;
  private readonly maxReseau: number;
  private readonly depuis: number;
  /** Contextes d'exécution venus d'une extension (scripts de contenu, monde isolé) : rien de ce qu'ils disent n'est retenu. */
  private readonly contextesExtension = new Set<number>();

  /** `depuis` : heure de l'attachement (ms) ; les messages plus anciens, rejoués par le protocole, sont écartés. */
  constructor(o: { maxConsole?: number; maxReseau?: number; depuis?: number } = {}) {
    this.maxConsole = o.maxConsole ?? 1000;
    this.maxReseau = o.maxReseau ?? 500;
    this.depuis = o.depuis ?? -Infinity;
  }

  private ajouter(m: MessageConsole): void {
    if (m.horodatage < this.depuis) return;
    this.messages.push({ ...m, texte: tronquer(m.texte), ...(m.pile !== undefined ? { pile: tronquer(m.pile) } : {}) });
    if (this.messages.length > this.maxConsole) this.messages.splice(0, this.messages.length - this.maxConsole);
  }

  evenement(methode: string, params: unknown): void {
    const p = (params ?? {}) as Record<string, any>; // forme libre du protocole
    switch (methode) {
      case "Runtime.executionContextCreated": {
        const c = p.context ?? {};
        if (typeof c.id !== "number") return;
        if (String(c.origin ?? "").startsWith(ORIGINE_EXTENSION)) this.contextesExtension.add(c.id);
        else this.contextesExtension.delete(c.id); // l'id est reparti de zéro avec un autre contexte
        return;
      }
      case "Runtime.executionContextDestroyed":
        this.contextesExtension.delete(p.executionContextId);
        return;
      case "Runtime.executionContextsCleared":
        this.contextesExtension.clear();
        return;
      case "Runtime.consoleAPICalled": {
        if (this.contextesExtension.has(p.executionContextId) || pileDExtension(p.stackTrace)) return;
        const pile = p.type === "error" || p.type === "assert" || p.type === "trace" ? textePile(p.stackTrace) : undefined;
        this.ajouter({
          horodatage: p.timestamp ?? Date.now(),
          niveau: NIVEAUX_CONSOLE[p.type] ?? "log",
          texte: ((p.args ?? []) as ObjetDistant[]).map(texteObjet).join(" "),
          ...(pile ? { pile } : {}),
        });
        return;
      }
      case "Runtime.exceptionThrown": {
        const d = p.exceptionDetails ?? {};
        if (this.contextesExtension.has(d.executionContextId) || String(d.url ?? "").startsWith(ORIGINE_EXTENSION) || pileDExtension(d.stackTrace)) return;
        const description: string | undefined = d.exception?.description;
        // `text` dit comment elle est survenue (« Uncaught », « Uncaught (in promise) »), comme dans la console de Chrome.
        const valeur = description?.split("\n")[0] ?? (d.exception ? texteObjet(d.exception) : "");
        const circonstance: string = d.text && !valeur.startsWith(d.text) ? d.text : "";
        const texte = [circonstance, valeur].filter(Boolean).join(" ") || "Exception";
        const pile = textePile(d.stackTrace) ?? (description?.includes("\n") ? description.slice(description.indexOf("\n") + 1) : undefined);
        this.ajouter({ horodatage: p.timestamp ?? Date.now(), niveau: "error", texte, ...(pile ? { pile } : {}) });
        return;
      }
      case "Log.entryAdded": {
        const e = p.entry ?? {};
        if (String(e.url ?? "").startsWith(ORIGINE_EXTENSION) || pileDExtension(e.stackTrace)) return;
        const pile = textePile(e.stackTrace);
        this.ajouter({ horodatage: e.timestamp ?? Date.now(), niveau: NIVEAUX_JOURNAL[e.level] ?? "log", texte: String(e.text ?? ""), ...(pile ? { pile } : {}) });
        return;
      }
      case "Network.requestWillBeSent": {
        // Ni la requête d'une extension (son URL, son document, son initiateur ou une pile parente), ni ce qui suit (sans entrée, ses événements sont ignorés).
        const i = p.initiator ?? {};
        if ([p.request?.url, p.documentURL, i.url].some((u) => String(u ?? "").startsWith(ORIGINE_EXTENSION)) || pileDExtension(i.stack)) {
          this.requetes.delete(p.requestId);
          this.debuts.delete(p.requestId);
          return;
        }
        // Une redirection garde l'id : la requête est remplacée par sa suite.
        this.requetes.delete(p.requestId);
        this.requetes.set(p.requestId, {
          id: p.requestId,
          horodatage: p.wallTime !== undefined ? ms(p.wallTime) : Date.now(),
          methode: p.request?.method ?? "GET",
          url: p.request?.url ?? "",
          ...(p.type ? { type: p.type } : {}),
          enTetesRequete: { ...p.request?.headers },
          enTetesReponse: {},
        });
        this.debuts.set(p.requestId, p.timestamp);
        for (const id of this.requetes.keys()) {
          if (this.requetes.size <= this.maxReseau) break;
          this.requetes.delete(id);
          this.debuts.delete(id);
        }
        return;
      }
      case "Network.responseReceived": {
        const r = this.requetes.get(p.requestId);
        if (!r) return;
        r.statut = p.response?.status;
        r.enTetesReponse = { ...p.response?.headers };
        // Les en-têtes réellement envoyés (cookies compris) ne sont connus qu'ici.
        if (p.response?.requestHeaders) r.enTetesRequete = { ...p.response.requestHeaders };
        if (p.type) r.type = p.type;
        return;
      }
      case "Network.loadingFinished":
      case "Network.loadingFailed": {
        const r = this.requetes.get(p.requestId);
        if (!r) return;
        const debut = this.debuts.get(p.requestId);
        if (debut !== undefined && p.timestamp !== undefined) r.dureeMs = Math.round(ms(p.timestamp - debut) * 1000) / 1000;
        if (methode === "Network.loadingFinished") r.taille = p.encodedDataLength;
        else r.erreur = p.errorText ?? (p.canceled ? "annulée" : "échec");
        return;
      }
    }
  }

  /** La page a été rechargée (ou a navigué sur le même site) : les messages restent, avec une ligne pour le signaler. */
  rechargement(): void {
    this.ajouter({ horodatage: Date.now(), niveau: "info", texte: "— page rechargée —" });
  }

  console(): MessageConsole[] {
    return this.messages.map((m) => ({ ...m }));
  }

  reseau(): RequeteReseau[] {
    return [...this.requetes.values()].map((r) => ({ ...r, enTetesRequete: { ...r.enTetesRequete }, enTetesReponse: { ...r.enTetesReponse } }));
  }

  vider(): void {
    this.messages = [];
    this.requetes.clear();
    this.debuts.clear();
  }
}
