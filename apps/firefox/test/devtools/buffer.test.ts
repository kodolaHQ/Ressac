import { describe, expect, test } from "vitest";
import { TabBuffer } from "../../core/devtools/buffer";

const chain = (value: string) => ({ type: "string", value });

const log = (t: TabBuffer, type: string, text: string, timestamp = 1000) =>
  t.evenement("Runtime.consoleAPICalled", { type, args: [chain(text)], timestamp });

describe("console", () => {
  test("keeps the order and levels of messages", () => {
    const t = new TabBuffer();
    log(t, "log", "un", 1);
    log(t, "warning", "deux", 2);
    log(t, "error", "trois", 3);
    t.evenement("Runtime.consoleAPICalled", { type: "info", args: [chain("quatre"), { type: "number", value: 4 }], timestamp: 4 });
    log(t, "debug", "cinq", 5);
    t.evenement("Log.entryAdded", { entry: { source: "network", level: "error", text: "six", timestamp: 6 } });
    t.evenement("Log.entryAdded", { entry: { source: "other", level: "verbose", text: "sept", timestamp: 7 } });
    expect(t.console().map((m) => [m.niveau, m.texte, m.horodatage])).toEqual([
      ["log", "un", 1],
      ["warn", "deux", 2],
      ["error", "trois", 3],
      ["info", "quatre 4", 4],
      ["debug", "cinq", 5],
      ["error", "six", 6],
      ["debug", "sept", 7],
    ]);
  });

  test("an object is shown by its description, a serialized object as JSON", () => {
    const t = new TabBuffer();
    t.evenement("Runtime.consoleAPICalled", {
      type: "log",
      args: [{ type: "object", className: "HTMLBodyElement", description: "body" }, { type: "object", value: { a: 1 } }, { type: "undefined" }],
      timestamp: 1,
    });
    expect(t.console()[0]!.texte).toBe('body {"a":1} undefined');
  });

  test("an exception carries its stack", () => {
    const t = new TabBuffer();
    t.evenement("Runtime.exceptionThrown", {
      timestamp: 10,
      exceptionDetails: {
        text: "Uncaught",
        exception: { type: "object", subtype: "error", description: "Error: boum\n    at clic (http://localhost:15280/:3:9)" },
        stackTrace: { callFrames: [{ functionName: "clic", url: "http://localhost:15280/", lineNumber: 2, columnNumber: 8 }] },
      },
    });
    const [m] = t.console();
    expect(m).toMatchObject({ niveau: "error", texte: "Uncaught Error: boum", horodatage: 10 });
    expect(m!.pile).toContain("at clic (http://localhost:15280/:3:9)");
  });

  test("beyond 1000 messages, the most recent stay", () => {
    const t = new TabBuffer();
    for (let i = 0; i < 1005; i++) log(t, "log", `m${i}`, i);
    const c = t.console();
    expect(c).toHaveLength(1000);
    expect(c[0]!.texte).toBe("m5");
    expect(c.at(-1)!.texte).toBe("m1004");
  });

  test("a text over 2000 characters is truncated", () => {
    const t = new TabBuffer();
    log(t, "log", "x".repeat(3000));
    expect(t.console()[0]!.texte).toBe(`${"x".repeat(2000)}… [tronqué]`);
  });

  test("messages from before the attachment, replayed by the protocol, are dropped", () => {
    const t = new TabBuffer({ depuis: 1000 });
    log(t, "log", "rejoué", 999);
    t.evenement("Runtime.exceptionThrown", { timestamp: 500, exceptionDetails: { text: "Uncaught", exception: { description: "Error: vieille" } } });
    t.evenement("Log.entryAdded", { entry: { level: "error", text: "vieux", timestamp: 10 } });
    log(t, "log", "nouveau", 1000);
    t.evenement("Log.entryAdded", { entry: { level: "warning", text: "récent", timestamp: 1001 } });
    expect(t.console().map((m) => m.texte)).toEqual(["nouveau", "récent"]);
  });

  test("rechargement() inserts « — page rechargée — »", () => {
    const t = new TabBuffer();
    log(t, "log", "avant");
    t.rechargement();
    log(t, "log", "après");
    expect(t.console().map((m) => m.texte)).toEqual(["avant", "— page rechargée —", "après"]);
  });
});

describe("network", () => {
  const sending = (t: TabBuffer, requestId: string, url: string, timestamp = 100) =>
    t.evenement("Network.requestWillBeSent", {
      requestId,
      request: { url, method: "GET", headers: { Accept: "*/*" } },
      timestamp,
      wallTime: 1_700_000_000,
      type: "Fetch",
    });

  test("a request gathers its response, status, duration and size", () => {
    const t = new TabBuffer();
    sending(t, "r1", "http://localhost:15280/texte.html");
    t.evenement("Network.responseReceived", {
      requestId: "r1",
      timestamp: 100.05,
      type: "Fetch",
      response: { status: 200, headers: { "Content-Type": "text/html" }, mimeType: "text/html" },
    });
    t.evenement("Network.loadingFinished", { requestId: "r1", timestamp: 100.25, encodedDataLength: 321 });
    expect(t.reseau()).toEqual([
      {
        id: "r1",
        horodatage: 1_700_000_000_000,
        methode: "GET",
        url: "http://localhost:15280/texte.html",
        statut: 200,
        dureeMs: 250,
        taille: 321,
        type: "Fetch",
        enTetesRequete: { Accept: "*/*" },
        enTetesReponse: { "Content-Type": "text/html" },
      },
    ]);
  });

  test("loadingFailed notes the error", () => {
    const t = new TabBuffer();
    sending(t, "r2", "http://localhost:1/");
    t.evenement("Network.loadingFailed", { requestId: "r2", timestamp: 100.5, errorText: "net::ERR_CONNECTION_REFUSED", type: "Fetch" });
    expect(t.reseau()[0]).toMatchObject({ id: "r2", erreur: "net::ERR_CONNECTION_REFUSED", dureeMs: 500 });
  });

  test("beyond 500 requests, the most recent stay", () => {
    const t = new TabBuffer();
    for (let i = 0; i < 503; i++) sending(t, `r${i}`, `http://localhost:15280/${i}`);
    const r = t.reseau();
    expect(r).toHaveLength(500);
    expect(r[0]!.id).toBe("r3");
  });

  test("events of an unknown request are ignored", () => {
    const t = new TabBuffer();
    t.evenement("Network.loadingFinished", { requestId: "inconnue", timestamp: 1, encodedDataLength: 1 });
    t.evenement("Page.loadEventFired", { timestamp: 1 });
    expect(t.reseau()).toEqual([]);
    expect(t.console()).toEqual([]);
  });
});

test("vider() clears the console and the network", () => {
  const t = new TabBuffer();
  log(t, "log", "un");
  t.evenement("Network.requestWillBeSent", { requestId: "r", request: { url: "http://x/", method: "GET", headers: {} }, timestamp: 1 });
  t.vider();
  expect(t.console()).toEqual([]);
  expect(t.reseau()).toEqual([]);
});

test("the caps are adjustable", () => {
  const t = new TabBuffer({ maxConsole: 2, maxReseau: 1 });
  for (let i = 0; i < 3; i++) log(t, "log", `m${i}`);
  expect(t.console().map((m) => m.texte)).toEqual(["m1", "m2"]);
});

describe("extension contexts", () => {
  const context = (t: TabBuffer, id: number, origin: string) =>
    t.evenement("Runtime.executionContextCreated", { context: { id, origin, name: "x" } });
  const logInside = (t: TabBuffer, id: number, text: string) =>
    t.evenement("Runtime.consoleAPICalled", { type: "log", args: [chain(text)], timestamp: 1000, executionContextId: id });

  test("a console.log from a chrome-extension:// context does not appear; the page's does", () => {
    const t = new TabBuffer();
    context(t, 1, "http://localhost:3000");
    context(t, 2, "chrome-extension://abcdefghijklmnopabcdefghijklmnop");
    logInside(t, 2, "de l'extension");
    logInside(t, 1, "de la page");
    expect(t.console().map((m) => m.texte)).toEqual(["de la page"]);
  });

  test("an exception from an extension script does not appear", () => {
    const t = new TabBuffer();
    context(t, 2, "chrome-extension://abcdefghijklmnopabcdefghijklmnop");
    t.evenement("Runtime.exceptionThrown", { timestamp: 1, exceptionDetails: { text: "Uncaught", executionContextId: 2, exception: { type: "object", description: "Error: ext" } } });
    t.evenement("Runtime.exceptionThrown", { timestamp: 2, exceptionDetails: { text: "Uncaught", executionContextId: 1, exception: { type: "object", description: "Error: page" } } });
    t.evenement("Log.entryAdded", { entry: { level: "error", text: "ext", url: "chrome-extension://abc/contenu.js", timestamp: 3 } });
    expect(t.console().map((m) => m.texte)).toEqual(["Uncaught Error: page"]);
  });

  test("a destroyed context is forgotten", () => {
    const t = new TabBuffer();
    context(t, 2, "chrome-extension://abc");
    t.evenement("Runtime.executionContextDestroyed", { executionContextId: 2 });
    logInside(t, 2, "visible");
    expect(t.console()).toHaveLength(1);
  });

  const request = (t: TabBuffer, requestId: string, extra: Record<string, unknown> = {}, url = "http://localhost:3000/api") =>
    t.evenement("Network.requestWillBeSent", { requestId, timestamp: 1, wallTime: 1, request: { url, method: "GET", headers: {} }, ...extra });

  test("a request whose initiator stack comes from an extension does not appear, nor its response", () => {
    const t = new TabBuffer();
    request(t, "a", {
      initiator: { type: "script", stack: { callFrames: [{ url: "http://localhost:3000/" }], parent: { callFrames: [{ url: "chrome-extension://abc/contenu.js" }] } } },
    });
    t.evenement("Network.responseReceived", { requestId: "a", response: { status: 200 } });
    t.evenement("Network.loadingFinished", { requestId: "a", timestamp: 2, encodedDataLength: 1 });
    request(t, "b", { initiator: { type: "script", url: "chrome-extension://abc/x.js" } });
    request(t, "c", { documentURL: "chrome-extension://abc/page.html" });
    request(t, "d", {}, "chrome-extension://abc/x.txt");
    request(t, "page", { initiator: { type: "script", stack: { callFrames: [{ url: "http://localhost:3000/" }] } } });
    expect(t.reseau().map((r) => r.id)).toEqual(["page"]);
  });

  test("after executionContextsCleared, a new context with the same id coming from the page is kept", () => {
    const t = new TabBuffer();
    context(t, 2, "chrome-extension://abc");
    t.evenement("Runtime.executionContextsCleared", {});
    context(t, 2, "http://localhost:3000");
    logInside(t, 2, "de la page");
    expect(t.console().map((m) => m.texte)).toEqual(["de la page"]);
  });

  test("the log entry of a failed extension request does not appear; a page request's does", () => {
    const t = new TabBuffer();
    request(t, "ext", { initiator: { type: "script", stack: { callFrames: [{ url: "chrome-extension://abc/c.js" }] } } }, "http://localhost:3000/absent");
    request(t, "pg", { initiator: { type: "script", stack: { callFrames: [{ url: "http://localhost:3000/" }] } } }, "http://localhost:3000/absent2");
    t.evenement("Log.entryAdded", { entry: { source: "network", level: "error", text: "Failed to load resource: 404", url: "http://localhost:3000/absent", networkRequestId: "ext", timestamp: 1 } });
    t.evenement("Log.entryAdded", { entry: { source: "network", level: "error", text: "Failed to load resource: 404 page", url: "http://localhost:3000/absent2", networkRequestId: "pg", timestamp: 2 } });
    expect(t.console().map((m) => m.texte)).toEqual(["Failed to load resource: 404 page"]);
  });

  test("the CORS message of an extension request (without id or stack) does not appear; a page request's does", () => {
    const t = new TabBuffer();
    request(t, "ext", { initiator: { type: "script", url: "chrome-extension://abc/c.js" } }, "http://localhost:3000/x");
    const cors = (u: string) => `Access to fetch at '${u}' from origin 'http://127.0.0.1:1' has been blocked by CORS policy`;
    t.evenement("Log.entryAdded", { entry: { category: "cors", source: "javascript", level: "error", text: cors("http://localhost:3000/x"), url: "http://127.0.0.1:1/", timestamp: 1 } });
    t.evenement("Log.entryAdded", { entry: { category: "cors", source: "javascript", level: "error", text: cors("http://localhost:3000/y"), url: "http://127.0.0.1:1/", timestamp: 2 } });
    expect(t.console().map((m) => m.texte)).toEqual([cors("http://localhost:3000/y")]);
  });

  test("retained extension request ids are bounded: the oldest is forgotten", () => {
    const t = new TabBuffer();
    const ext = { initiator: { type: "script", url: "chrome-extension://abc/c.js" } };
    for (let i = 0; i < 1001; i++) request(t, `e${i}`, ext);
    t.evenement("Log.entryAdded", { entry: { level: "error", text: "vieille", networkRequestId: "e0", timestamp: 1 } });
    t.evenement("Log.entryAdded", { entry: { level: "error", text: "récente", networkRequestId: "e1000", timestamp: 2 } });
    expect(t.console().map((m) => m.texte)).toEqual(["vieille"]);
  });

  test("console and exception are filtered by the stack alone, or by the url alone", () => {
    const t = new TabBuffer();
    t.evenement("Runtime.consoleAPICalled", { type: "error", args: [chain("pile-ext")], timestamp: 1, stackTrace: { callFrames: [{ url: "chrome-extension://abc/c.js" }] } });
    t.evenement("Runtime.exceptionThrown", { timestamp: 2, exceptionDetails: { text: "Uncaught", exception: { type: "object", description: "Error: pile-ext" }, stackTrace: { callFrames: [{ url: "chrome-extension://abc/c.js" }] } } });
    t.evenement("Runtime.exceptionThrown", { timestamp: 3, exceptionDetails: { text: "Uncaught", url: "chrome-extension://abc/c.js", exception: { type: "object", description: "Error: url-ext" } } });
    log(t, "log", "page", 4);
    expect(t.console().map((m) => m.texte)).toEqual(["page"]);
  });
});
