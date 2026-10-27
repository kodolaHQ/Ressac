import { describe, expect, test } from "vitest";
import { TamponOnglet } from "../../src/main/outils-dev/tampon";

const chaine = (value: string) => ({ type: "string", value });

const log = (t: TamponOnglet, type: string, texte: string, timestamp = 1000) =>
  t.evenement("Runtime.consoleAPICalled", { type, args: [chaine(texte)], timestamp });

describe("console", () => {
  test("garde l'ordre et les niveaux des messages", () => {
    const t = new TamponOnglet();
    log(t, "log", "un", 1);
    log(t, "warning", "deux", 2);
    log(t, "error", "trois", 3);
    t.evenement("Runtime.consoleAPICalled", { type: "info", args: [chaine("quatre"), { type: "number", value: 4 }], timestamp: 4 });
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

  test("un objet est montré par sa description, un objet sérialisé en JSON", () => {
    const t = new TamponOnglet();
    t.evenement("Runtime.consoleAPICalled", {
      type: "log",
      args: [{ type: "object", className: "HTMLBodyElement", description: "body" }, { type: "object", value: { a: 1 } }, { type: "undefined" }],
      timestamp: 1,
    });
    expect(t.console()[0]!.texte).toBe('body {"a":1} undefined');
  });

  test("une exception porte sa pile", () => {
    const t = new TamponOnglet();
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

  test("au-delà de 1000 messages, les plus récents restent", () => {
    const t = new TamponOnglet();
    for (let i = 0; i < 1005; i++) log(t, "log", `m${i}`, i);
    const c = t.console();
    expect(c).toHaveLength(1000);
    expect(c[0]!.texte).toBe("m5");
    expect(c.at(-1)!.texte).toBe("m1004");
  });

  test("un texte de plus de 2000 caractères est tronqué", () => {
    const t = new TamponOnglet();
    log(t, "log", "x".repeat(3000));
    expect(t.console()[0]!.texte).toBe(`${"x".repeat(2000)}… [tronqué]`);
  });

  test("les messages antérieurs à l'attachement, rejoués par le protocole, sont écartés", () => {
    const t = new TamponOnglet({ depuis: 1000 });
    log(t, "log", "rejoué", 999);
    t.evenement("Runtime.exceptionThrown", { timestamp: 500, exceptionDetails: { text: "Uncaught", exception: { description: "Error: vieille" } } });
    t.evenement("Log.entryAdded", { entry: { level: "error", text: "vieux", timestamp: 10 } });
    log(t, "log", "nouveau", 1000);
    t.evenement("Log.entryAdded", { entry: { level: "warning", text: "récent", timestamp: 1001 } });
    expect(t.console().map((m) => m.texte)).toEqual(["nouveau", "récent"]);
  });

  test("rechargement() insère « — page rechargée — »", () => {
    const t = new TamponOnglet();
    log(t, "log", "avant");
    t.rechargement();
    log(t, "log", "après");
    expect(t.console().map((m) => m.texte)).toEqual(["avant", "— page rechargée —", "après"]);
  });
});

describe("réseau", () => {
  const envoi = (t: TamponOnglet, requestId: string, url: string, timestamp = 100) =>
    t.evenement("Network.requestWillBeSent", {
      requestId,
      request: { url, method: "GET", headers: { Accept: "*/*" } },
      timestamp,
      wallTime: 1_700_000_000,
      type: "Fetch",
    });

  test("une requête réunit sa réponse, son statut, sa durée et sa taille", () => {
    const t = new TamponOnglet();
    envoi(t, "r1", "http://localhost:15280/texte.html");
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

  test("loadingFailed note l'erreur", () => {
    const t = new TamponOnglet();
    envoi(t, "r2", "http://localhost:1/");
    t.evenement("Network.loadingFailed", { requestId: "r2", timestamp: 100.5, errorText: "net::ERR_CONNECTION_REFUSED", type: "Fetch" });
    expect(t.reseau()[0]).toMatchObject({ id: "r2", erreur: "net::ERR_CONNECTION_REFUSED", dureeMs: 500 });
  });

  test("au-delà de 500 requêtes, les plus récentes restent", () => {
    const t = new TamponOnglet();
    for (let i = 0; i < 503; i++) envoi(t, `r${i}`, `http://localhost:15280/${i}`);
    const r = t.reseau();
    expect(r).toHaveLength(500);
    expect(r[0]!.id).toBe("r3");
  });

  test("les événements d'une requête inconnue sont ignorés", () => {
    const t = new TamponOnglet();
    t.evenement("Network.loadingFinished", { requestId: "inconnue", timestamp: 1, encodedDataLength: 1 });
    t.evenement("Page.loadEventFired", { timestamp: 1 });
    expect(t.reseau()).toEqual([]);
    expect(t.console()).toEqual([]);
  });
});

test("vider() vide la console et le réseau", () => {
  const t = new TamponOnglet();
  log(t, "log", "un");
  t.evenement("Network.requestWillBeSent", { requestId: "r", request: { url: "http://x/", method: "GET", headers: {} }, timestamp: 1 });
  t.vider();
  expect(t.console()).toEqual([]);
  expect(t.reseau()).toEqual([]);
});

test("les plafonds se règlent", () => {
  const t = new TamponOnglet({ maxConsole: 2, maxReseau: 1 });
  for (let i = 0; i < 3; i++) log(t, "log", `m${i}`);
  expect(t.console().map((m) => m.texte)).toEqual(["m1", "m2"]);
});
