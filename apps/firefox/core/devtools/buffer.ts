import { truncate, type MessageConsole, type NetworkRequest } from "@webaios/kernel";

/** Value of a console argument or an exception (the protocol's Runtime.RemoteObject). */
interface RemoteObject {
  type?: string;
  value?: unknown;
  unserializableValue?: string;
  description?: string;
}

interface Stack {
  callFrames?: { functionName?: string; url?: string; lineNumber?: number; columnNumber?: number }[];
  parent?: Stack;
}

const EXTENSION_ORIGIN = "chrome-extension://";

/** A stack (parents included) has a frame in an extension script. */
function extensionStack(p: Stack | undefined): boolean {
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
export function stackText(p: Stack | undefined): string | undefined {
  const frames = p?.callFrames ?? [];
  if (!frames.length) return undefined;
  return frames
    .map((c) => {
      const where = `${c.url ?? ""}:${(c.lineNumber ?? 0) + 1}:${(c.columnNumber ?? 0) + 1}`;
      return c.functionName ? `    at ${c.functionName} (${where})` : `    at ${where}`;
    })
    .join("\n");
}

const CONSOLE_LEVELS: Record<string, MessageConsole["level"]> = {
  warning: "warn",
  error: "error",
  assert: "error",
  info: "info",
  debug: "debug",
};

const LOG_LEVELS: Record<string, MessageConsole["level"]> = {
  verbose: "debug",
  info: "info",
  warning: "warn",
  error: "error",
};

/** Protocol timestamp (seconds, monotonic clock) → milliseconds. */
const ms = (seconds: number) => seconds * 1000;

/**
 * Console and network of a tab, drawn from the events of the developer tools protocol (Chrome DevTools
 * Protocol). Pure: the inspector passes it the events, it keeps the most recent.
 */
export class TabBuffer {
  private messages: MessageConsole[] = [];
  /** By request id, in sending order. */
  private readonly requests = new Map<string, NetworkRequest>();
  /** Start of each request, on the protocol's monotonic clock (for the duration). */
  private readonly starts = new Map<string, number>();
  private readonly maxConsole: number;
  private readonly maxNetwork: number;
  private readonly since: number;
  /** Ids of the discarded extension requests (the most recent): their log entries (failure, CORS) are too. */
  private readonly extensionRequests = new Map<string, string>();
  /** Execution contexts coming from an extension (content scripts, isolated world): nothing they say is kept. */
  private readonly extensionContexts = new Set<number>();

  /** `depuis`: attach time (ms); older messages, replayed by the protocol, are discarded. */
  constructor(o: { maxConsole?: number; maxNetwork?: number; since?: number } = {}) {
    this.maxConsole = o.maxConsole ?? 1000;
    this.maxNetwork = o.maxNetwork ?? 500;
    this.since = o.since ?? -Infinity;
  }

  private add(m: MessageConsole): void {
    if (m.timestamp < this.since) return;
    this.messages.push({ ...m, text: truncate(m.text), ...(m.stack !== undefined ? { stack: truncate(m.stack) } : {}) });
    if (this.messages.length > this.maxConsole) this.messages.splice(0, this.messages.length - this.maxConsole);
  }

  event(method: string, params: unknown): void {
    const p = (params ?? {}) as Record<string, any>; // free-form protocol shape
    switch (method) {
      case "Runtime.executionContextCreated": {
        const c = p.context ?? {};
        if (typeof c.id !== "number") return;
        if (String(c.origin ?? "").startsWith(EXTENSION_ORIGIN)) this.extensionContexts.add(c.id);
        else this.extensionContexts.delete(c.id); // the id restarted from zero with another context
        return;
      }
      case "Runtime.executionContextDestroyed":
        this.extensionContexts.delete(p.executionContextId);
        return;
      case "Runtime.executionContextsCleared":
        this.extensionContexts.clear();
        return;
      case "Runtime.consoleAPICalled": {
        if (this.extensionContexts.has(p.executionContextId) || extensionStack(p.stackTrace)) return;
        const stack = p.type === "error" || p.type === "assert" || p.type === "trace" ? stackText(p.stackTrace) : undefined;
        this.add({
          timestamp: p.timestamp ?? Date.now(),
          level: CONSOLE_LEVELS[p.type] ?? "log",
          text: ((p.args ?? []) as RemoteObject[]).map(objectText).join(" "),
          ...(stack ? { stack: stack } : {}),
        });
        return;
      }
      case "Runtime.exceptionThrown": {
        const d = p.exceptionDetails ?? {};
        if (this.extensionContexts.has(d.executionContextId) || String(d.url ?? "").startsWith(EXTENSION_ORIGIN) || extensionStack(d.stackTrace)) return;
        const description: string | undefined = d.exception?.description;
        // `text` says how it occurred (« Uncaught », « Uncaught (in promise) »), as in Chrome's console.
        const value = description?.split("\n")[0] ?? (d.exception ? objectText(d.exception) : "");
        const circumstance: string = d.text && !value.startsWith(d.text) ? d.text : "";
        const text = [circumstance, value].filter(Boolean).join(" ") || "Exception";
        const stack = stackText(d.stackTrace) ?? (description?.includes("\n") ? description.slice(description.indexOf("\n") + 1) : undefined);
        this.add({ timestamp: p.timestamp ?? Date.now(), level: "error", text: text, ...(stack ? { stack: stack } : {}) });
        return;
      }
      case "Log.entryAdded": {
        const e = p.entry ?? {};
        // The CORS message (source « javascript ») has neither a request id nor a stack, and carries the page's address: only the requested
        // address, quoted in its text, links it to the extension request.
        const text = String(e.text ?? "");
        if (this.extensionRequests.has(e.networkRequestId) || (e.category === "cors" && [...this.extensionRequests.values()].some((u) => u && text.includes(`'${u}'`))) || String(e.url ?? "").startsWith(EXTENSION_ORIGIN) || extensionStack(e.stackTrace)) return;
        const stack = stackText(e.stackTrace);
        this.add({ timestamp: e.timestamp ?? Date.now(), level: LOG_LEVELS[e.level] ?? "log", text: String(e.text ?? ""), ...(stack ? { stack: stack } : {}) });
        return;
      }
      case "Network.requestWillBeSent": {
        // Neither an extension's request (its URL, its document, its initiator or a parent stack), nor what follows (without an entry, its events are ignored).
        const i = p.initiator ?? {};
        if ([p.request?.url, p.documentURL, i.url].some((u) => String(u ?? "").startsWith(EXTENSION_ORIGIN)) || extensionStack(i.stack)) {
          this.requests.delete(p.requestId);
          this.starts.delete(p.requestId);
          this.extensionRequests.delete(p.requestId);
          this.extensionRequests.set(p.requestId, String(p.request?.url ?? ""));
          for (const id of this.extensionRequests.keys()) {
            if (this.extensionRequests.size <= 1000) break;
            this.extensionRequests.delete(id);
          }
          return;
        }
        this.extensionRequests.delete(p.requestId);
        // A redirect keeps the id: the request is replaced by its continuation.
        this.requests.delete(p.requestId);
        this.requests.set(p.requestId, {
          id: p.requestId,
          timestamp: p.wallTime !== undefined ? ms(p.wallTime) : Date.now(),
          method: p.request?.method ?? "GET",
          url: p.request?.url ?? "",
          ...(p.type ? { type: p.type } : {}),
          requestHeaders: { ...p.request?.headers },
          responseHeaders: {},
        });
        this.starts.set(p.requestId, p.timestamp);
        for (const id of this.requests.keys()) {
          if (this.requests.size <= this.maxNetwork) break;
          this.requests.delete(id);
          this.starts.delete(id);
        }
        return;
      }
      case "Network.responseReceived": {
        const r = this.requests.get(p.requestId);
        if (!r) return;
        r.status = p.response?.status;
        r.responseHeaders = { ...p.response?.headers };
        // The headers actually sent (cookies included) are only known here.
        if (p.response?.requestHeaders) r.requestHeaders = { ...p.response.requestHeaders };
        if (p.type) r.type = p.type;
        return;
      }
      case "Network.loadingFinished":
      case "Network.loadingFailed": {
        const r = this.requests.get(p.requestId);
        if (!r) return;
        const start = this.starts.get(p.requestId);
        if (start !== undefined && p.timestamp !== undefined) r.durationMs = Math.round(ms(p.timestamp - start) * 1000) / 1000;
        if (method === "Network.loadingFinished") r.size = p.encodedDataLength;
        else r.error = p.errorText ?? (p.canceled ? "annulée" : "échec");
        return;
      }
    }
  }

  /** The page was reloaded (or navigated on the same site): the messages stay, with a line to flag it. */
  reload(): void {
    this.add({ timestamp: Date.now(), level: "info", text: "— page rechargée —" });
  }

  console(): MessageConsole[] {
    return this.messages.map((m) => ({ ...m }));
  }

  network(): NetworkRequest[] {
    return [...this.requests.values()].map((r) => ({ ...r, requestHeaders: { ...r.requestHeaders }, responseHeaders: { ...r.responseHeaders } }));
  }

  clear(): void {
    this.messages = [];
    this.requests.clear();
    this.starts.clear();
  }
}
