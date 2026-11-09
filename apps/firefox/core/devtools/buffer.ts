import { truncate, type MessageConsole, type NetworkRequest } from "@webaios/kernel";

/** Value of a console argument or an exception (the protocol's Runtime.RemoteObject). */
interface RemoteObject {
  type?: string;
  value?: unknown;
  unserializableValue?: string;
  description?: string;
}

interface Pile {
  callFrames?: { functionName?: string; url?: string; lineNumber?: number; columnNumber?: number }[];
  parent?: Pile;
}

const EXTENSION_ORIGIN = "chrome-extension://";

/** A stack (parents included) has a frame in an extension script. */
function pileDExtension(p: Pile | undefined): boolean {
  for (let n = 0; p && n < 50; p = p.parent, n++) if (p.callFrames?.some((c) => c.url?.startsWith(EXTENSION_ORIGIN))) return true;
  return false;
}

/** Text of a remote value: the string as is, the JSON of a serialized value, otherwise its description. */
export function objectText(o: RemoteObject): string {
  if (o.type === "undefined") return "undefined";
  if (o.value !== undefined) return typeof o.value === "string" ? o.value : JSON.stringify(o.value);
  return o.unserializableValue ?? o.description ?? String(o.type ?? "");
}

/** Stack in V8's format (`    at f (url:line:column)`), lines and columns counted from 1. */
export function stackText(p: Pile | undefined): string | undefined {
  const cadres = p?.callFrames ?? [];
  if (!cadres.length) return undefined;
  return cadres
    .map((c) => {
      const lieu = `${c.url ?? ""}:${(c.lineNumber ?? 0) + 1}:${(c.columnNumber ?? 0) + 1}`;
      return c.functionName ? `    at ${c.functionName} (${lieu})` : `    at ${lieu}`;
    })
    .join("\n");
}

const CONSOLE_LEVELS: Record<string, MessageConsole["niveau"]> = {
  warning: "warn",
  error: "error",
  assert: "error",
  info: "info",
  debug: "debug",
};

const LOG_LEVELS: Record<string, MessageConsole["niveau"]> = {
  verbose: "debug",
  info: "info",
  warning: "warn",
  error: "error",
};

/** Protocol timestamp (seconds, monotonic clock) → milliseconds. */
const ms = (secondes: number) => secondes * 1000;

/**
 * Console and network of a tab, drawn from the events of the developer tools protocol (Chrome DevTools
 * Protocol). Pure: the inspector passes it the events, it keeps the most recent.
 */
export class TabBuffer {
  private messages: MessageConsole[] = [];
  /** By request id, in sending order. */
  private readonly requetes = new Map<string, NetworkRequest>();
  /** Start of each request, on the protocol's monotonic clock (for the duration). */
  private readonly debuts = new Map<string, number>();
  private readonly maxConsole: number;
  private readonly maxReseau: number;
  private readonly depuis: number;
  /** Ids of the discarded extension requests (the most recent): their log entries (failure, CORS) are too. */
  private readonly requetesExtension = new Map<string, string>();
  /** Execution contexts coming from an extension (content scripts, isolated world): nothing they say is kept. */
  private readonly contextesExtension = new Set<number>();

  /** `depuis`: attach time (ms); older messages, replayed by the protocol, are discarded. */
  constructor(o: { maxConsole?: number; maxReseau?: number; depuis?: number } = {}) {
    this.maxConsole = o.maxConsole ?? 1000;
    this.maxReseau = o.maxReseau ?? 500;
    this.depuis = o.depuis ?? -Infinity;
  }

  private ajouter(m: MessageConsole): void {
    if (m.horodatage < this.depuis) return;
    this.messages.push({ ...m, texte: truncate(m.texte), ...(m.pile !== undefined ? { pile: truncate(m.pile) } : {}) });
    if (this.messages.length > this.maxConsole) this.messages.splice(0, this.messages.length - this.maxConsole);
  }

  evenement(method: string, params: unknown): void {
    const p = (params ?? {}) as Record<string, any>; // free-form protocol shape
    switch (method) {
      case "Runtime.executionContextCreated": {
        const c = p.context ?? {};
        if (typeof c.id !== "number") return;
        if (String(c.origin ?? "").startsWith(EXTENSION_ORIGIN)) this.contextesExtension.add(c.id);
        else this.contextesExtension.delete(c.id); // the id restarted from zero with another context
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
        const pile = p.type === "error" || p.type === "assert" || p.type === "trace" ? stackText(p.stackTrace) : undefined;
        this.ajouter({
          horodatage: p.timestamp ?? Date.now(),
          niveau: CONSOLE_LEVELS[p.type] ?? "log",
          texte: ((p.args ?? []) as RemoteObject[]).map(objectText).join(" "),
          ...(pile ? { pile } : {}),
        });
        return;
      }
      case "Runtime.exceptionThrown": {
        const d = p.exceptionDetails ?? {};
        if (this.contextesExtension.has(d.executionContextId) || String(d.url ?? "").startsWith(EXTENSION_ORIGIN) || pileDExtension(d.stackTrace)) return;
        const description: string | undefined = d.exception?.description;
        // `text` says how it occurred (« Uncaught », « Uncaught (in promise) »), as in Chrome's console.
        const valeur = description?.split("\n")[0] ?? (d.exception ? objectText(d.exception) : "");
        const circumstance: string = d.text && !valeur.startsWith(d.text) ? d.text : "";
        const text = [circumstance, valeur].filter(Boolean).join(" ") || "Exception";
        const pile = stackText(d.stackTrace) ?? (description?.includes("\n") ? description.slice(description.indexOf("\n") + 1) : undefined);
        this.ajouter({ horodatage: p.timestamp ?? Date.now(), niveau: "error", texte: text, ...(pile ? { pile } : {}) });
        return;
      }
      case "Log.entryAdded": {
        const e = p.entry ?? {};
        // The CORS message (source « javascript ») has neither a request id nor a stack, and carries the page's address: only the requested
        // address, quoted in its text, links it to the extension request.
        const text = String(e.text ?? "");
        if (this.requetesExtension.has(e.networkRequestId) || (e.category === "cors" && [...this.requetesExtension.values()].some((u) => u && text.includes(`'${u}'`))) || String(e.url ?? "").startsWith(EXTENSION_ORIGIN) || pileDExtension(e.stackTrace)) return;
        const pile = stackText(e.stackTrace);
        this.ajouter({ horodatage: e.timestamp ?? Date.now(), niveau: LOG_LEVELS[e.level] ?? "log", texte: String(e.text ?? ""), ...(pile ? { pile } : {}) });
        return;
      }
      case "Network.requestWillBeSent": {
        // Neither an extension's request (its URL, its document, its initiator or a parent stack), nor what follows (without an entry, its events are ignored).
        const i = p.initiator ?? {};
        if ([p.request?.url, p.documentURL, i.url].some((u) => String(u ?? "").startsWith(EXTENSION_ORIGIN)) || pileDExtension(i.stack)) {
          this.requetes.delete(p.requestId);
          this.debuts.delete(p.requestId);
          this.requetesExtension.delete(p.requestId);
          this.requetesExtension.set(p.requestId, String(p.request?.url ?? ""));
          for (const id of this.requetesExtension.keys()) {
            if (this.requetesExtension.size <= 1000) break;
            this.requetesExtension.delete(id);
          }
          return;
        }
        this.requetesExtension.delete(p.requestId);
        // A redirect keeps the id: the request is replaced by its continuation.
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
        // The headers actually sent (cookies included) are only known here.
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
        if (method === "Network.loadingFinished") r.taille = p.encodedDataLength;
        else r.erreur = p.errorText ?? (p.canceled ? "annulée" : "échec");
        return;
      }
    }
  }

  /** The page was reloaded (or navigated on the same site): the messages stay, with a line to flag it. */
  rechargement(): void {
    this.ajouter({ horodatage: Date.now(), niveau: "info", texte: "— page rechargée —" });
  }

  console(): MessageConsole[] {
    return this.messages.map((m) => ({ ...m }));
  }

  reseau(): NetworkRequest[] {
    return [...this.requetes.values()].map((r) => ({ ...r, enTetesRequete: { ...r.enTetesRequete }, enTetesReponse: { ...r.enTetesReponse } }));
  }

  vider(): void {
    this.messages = [];
    this.requetes.clear();
    this.debuts.clear();
  }
}
