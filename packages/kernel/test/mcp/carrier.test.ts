import { expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AccessPolicy, DEV_RIGHTS } from "../../src/access/policy.js";
import type { TabInfo } from "../../src/mcp/bridge.js";
import { FakeBridge } from "../../src/mcp/fake-bridge.js";
import { carrier, generateToken, MOVING_TEXT, sourceZone, startMcpServer, type ActionsTools, type SitesTools, type WidgetsTools } from "../../src/mcp/server.js";
import { Masker } from "../../src/mask/masker.js";
import { PassportStore } from "../../src/mask/passport.js";
import { CARD, IBAN, PHONE, windows } from "../mask/values.js";

const HOST = "https://mail.example-novacourriel.test";
/** The user's webmail (sensitive by its `mail.` host), reached by them. */
const mail: TabInfo = { id: "mail", title: "Boîte de réception", url: `${HOST}/inbox`, space: "perso", agentReached: false };
/** A page of the rest of the web, reached by the agent. */
const news: TabInfo = { id: "news", title: "Actualités", url: "https://news.test/a", space: "perso", agentReached: true };
const OTHER_PHONE = "07" + "98" + "76" + "54" + "32";
const REFUSED = "Capture refusée : cet onglet montre vos données.";
const CARD_TEXT = "Les outils de développement verraient vos données en clair.";
const DENIAL = "Accès refusé par l'utilisateur à cet outil sur cet onglet.";

type Opts = ConstructorParameters<typeof FakeBridge>[1];
type Call = (name: string, args: Record<string, unknown>) => Promise<{ text: string; image: boolean; isError: boolean }>;

async function serve(
  o: { bridge?: Partial<Opts>; widgets?: WidgetsTools; actions?: ActionsTools; sites?: SitesTools; tabs?: TabInfo[] },
  attempt: (x: { call: Call; bridge: FakeBridge; policy: AccessPolicy; page: (id: string, text: string) => void; masker: Masker }) => Promise<void>,
) {
  const bridge = new FakeBridge(o.tabs ?? [mail, news], { active: "mail", allow: true, devTools: true, grantDev: [...DEV_RIGHTS], ...o.bridge });
  const page = (id: string, text: string) => bridge.pages.set(id, { text });
  page("mail", `Camille Exemple\nTél : ${PHONE}`);
  page("news", "Les nouvelles du jour.");
  const policy = new AccessPolicy();
  const token = generateToken();
  const masker = new Masker();
  const s = await startMcpServer({ lab: () => true, bridge, policy, token, masker, locale: () => "fr", agent: "Claude", ...(o.widgets ? { widgets: o.widgets } : {}), ...(o.actions ? { actions: o.actions } : {}), ...(o.sites ? { sites: o.sites } : {}) });
  masker.open("A", "W1");
  const session = s.openSession("W1", undefined, "A");
  const clients: Client[] = [];
  const call: Call = async (name, args) => {
    const c = new Client({ name: "test", version: "0" });
    clients.push(c);
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${s.port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${session}` } } }));
    const r = await c.callTool({ name, arguments: args });
    const content = r.content as { type: string; text?: string }[];
    return { text: content.map((x) => x.text ?? "").join("\n"), image: content.some((x) => x.type === "image"), isError: r.isError === true };
  };
  try {
    await attempt({ call, bridge, policy, page, masker });
  } finally {
    await Promise.all(clients.map((c) => c.close()));
    await s.stop();
  }
}

const unlockCards = (b: FakeBridge) => b.calls.filter((c) => c.method === "askDevUnlock");
const captures = (b: FakeBridge) => b.calls.filter((c) => c.method === "capture").length;

test("carrier: a sensitive site, or a high-risk shape on a web page; never a phone on a web page", () => {
  expect(carrier(mail, "rien")).toBe(true);
  expect(carrier(news, `Carte ${CARD}`)).toBe(true);
  expect(carrier(news, `Tél : ${PHONE}`)).toBe(false);
});

/** A passport whose name entry is fillable on the shop below, a plain site the sensitive list does not know. */
const passport = new PassportStore();
passport.replace("p1", [
  { id: "0000000000000001", field: "nom", value: { given: "Camille", family: "Aubrac" }, variants: [], origins: ["boutique-exemple.test"], how: "typed", created: "2026-11-23T10:00:00.000Z", updated: "2026-11-23T10:00:00.000Z" },
]);
const shop: TabInfo = { id: "shop", title: "Ma commande", url: "https://boutique-exemple.test/commande", space: "perso", agentReached: false };

test("sourceZone: a tab the user reached on a passport origin is a source; reached by the agent, it stays web", () => {
  expect(sourceZone(shop, false, passport.origins())).toBe("sources");
  expect(sourceZone({ ...shop, agentReached: true }, false, passport.origins())).toBe("web");
  expect(sourceZone(shop)).toBe("web");
});

test("carrier: a passport name makes a sources tab a carrier, never a web one", () => {
  expect(carrier(shop, "Bonjour C. Aubrac", false, passport)).toBe(true);
  expect(carrier(shop, "Bonjour", false, passport)).toBe(false);
  expect(carrier({ ...shop, agentReached: true }, "Bonjour C. Aubrac", false, passport)).toBe(false);
  expect(carrier(news, "Bonjour C. Aubrac", false, passport)).toBe(false);
});

test("carrier: a passport name written only with escapes still makes a sources tab a carrier", () => {
  expect(carrier(shop, '{"name":"C. \\u0041ubrac"}', false, passport)).toBe(true);
  expect(carrier(shop, "Bonjour C&#46; &#65;ubrac", false, passport)).toBe(true);
  expect(carrier(news, '{"name":"C. \\u0041ubrac"}', false, passport)).toBe(false);
});

test("capture of a sensitive tab is refused, before any capture", async () => {
  await serve({}, async ({ call, bridge }) => {
    const r = await call("capture_screen", { id: "mail" });
    expect(r).toEqual({ text: REFUSED, image: false, isError: false });
    expect(captures(bridge)).toBe(0);
  });
});

test("capture of a web page showing a card number is refused; one showing only a phone is allowed", async () => {
  await serve({}, async ({ call, page, bridge }) => {
    page("news", `Paiement avec la carte ${CARD}`);
    expect((await call("capture_screen", { id: "news" })).text).toBe(REFUSED);
    expect(captures(bridge)).toBe(0);
  });
  await serve({}, async ({ call, page }) => {
    page("news", `Appelle le ${PHONE}`);
    expect((await call("capture_screen", { id: "news" })).image).toBe(true);
  });
});

test("no oracle: a web page showing the user's own phone gets the same answers as one showing another phone", async () => {
  const answers: string[][] = [];
  for (const phone of [PHONE, OTHER_PHONE]) {
    await serve({ bridge: { devUnlock: true } }, async ({ call, page, bridge, masker }) => {
      // The user's phone is now a sources entry of this conversation's table.
      expect((await call("read_tab", { id: "mail" })).text).toMatch(/⟨tel-[a-z0-9]{8}⟩/);
      expect(masker.table("A").entries("sources").some((e) => e.type === "tel")).toBe(true);
      page("news", `Appelle le ${phone}`);
      const capture = await call("capture_screen", { id: "news" });
      const console = await call("read_console", { id: "news" });
      answers.push([String(capture.image), capture.text, console.text, String(unlockCards(bridge).length)]);
    });
  }
  expect(answers[0]).toEqual(["true", "", "Aucun message.", "0"]);
  expect(answers[1]).toEqual(answers[0]);
});

test("a page that injects an IBAN after an allowed capture is refused at the next call", async () => {
  await serve({}, async ({ call, page }) => {
    expect((await call("capture_screen", { id: "news" })).image).toBe(true);
    page("news", `Virement vers ${IBAN}`);
    expect((await call("capture_screen", { id: "news" })).text).toBe(REFUSED);
  });
});

test("the lock is sticky: the value removed keeps it; a navigation to another origin lifts the capture lock, not the dev tools one", async () => {
  await serve({ bridge: { devUnlock: false } }, async ({ call, page, bridge, policy }) => {
    page("news", `Carte ${CARD}`);
    expect((await call("capture_screen", { id: "news" })).text).toBe(REFUSED);
    // The page removes the value: still a carrier on this origin.
    page("news", "Plus rien.");
    expect((await call("capture_screen", { id: "news" })).text).toBe(REFUSED);
    // Same origin, another page: still locked.
    bridge.editTab("news", { url: "https://news.test/b" });
    policy.tabNavigated("news", "https://news.test/b");
    expect((await call("capture_screen", { id: "news" })).text).toBe(REFUSED);
    bridge.editTab("news", { url: "https://other.test/" });
    policy.tabNavigated("news", "https://other.test/");
    expect((await call("capture_screen", { id: "news" })).image).toBe(true);
    // Its dev tools buffers may still hold the previous origin's entries.
    expect((await call("read_console", { id: "news" })).text).toBe(DENIAL);
    expect(unlockCards(bridge)).toHaveLength(1);
    // Closed, the tab forgets it.
    policy.tabClosed("news");
    expect((await call("read_console", { id: "news" })).text).toBe("Aucun message.");
  });
});

test("read_console on a carrier tab: the unlock card; refused → denial, the console never read", async () => {
  await serve({ bridge: { devUnlock: false } }, async ({ call, bridge }) => {
    bridge.setConsole("mail", [{ timestamp: 1, level: "log", text: `Carte ${CARD}` }]);
    expect((await call("read_console", { id: "mail" })).text).toBe(DENIAL);
    expect(unlockCards(bridge)[0]!.args).toEqual([{ ...mail }, { agent: "Claude", text: CARD_TEXT }]);
    expect(bridge.calls.some((c) => c.method === "console")).toBe(false);
  });
});

test("read_console on a carrier tab, unlocked: passes, masked, one card for the conversation; a new conversation asks again", async () => {
  await serve({ bridge: { devUnlock: true } }, async ({ call, bridge, policy }) => {
    bridge.setConsole("mail", [{ timestamp: 1, level: "log", text: `Carte ${CARD}` }]);
    const r = (await call("read_console", { id: "mail" })).text;
    expect(r).toMatch(/\[log\] Carte ⟨carte-[a-z0-9]{8}⟩/);
    expect(windows(CARD).filter((w) => r.includes(w))).toEqual([]);
    await call("read_console", { id: "mail" });
    expect(unlockCards(bridge)).toHaveLength(1);
    policy.reset();
    await call("read_console", { id: "mail" });
    expect(unlockCards(bridge)).toHaveLength(2);
  });
});

test("every listed dev tool is locked on a carrier tab, compare_memory included; profile_performance is not", async () => {
  await serve({ bridge: { devUnlock: false } }, async ({ call, bridge }) => {
    for (const [name, args] of [
      ["run_js", { code: "1" }],
      ["read_network", {}],
      ["read_request", { request: "r1" }],
      ["memory_snapshot", {}],
      ["compare_memory", { a: "profile:a", b: "profile:b" }],
    ] as const)
      expect((await call(name, { id: "mail", ...args })).text, name).toBe(DENIAL);
    expect(bridge.calls.some((c) => ["run", "network", "memorySnapshot"].includes(c.method))).toBe(false);
    expect((await call("profile_performance", { id: "mail", duration_s: 1 })).text).not.toBe(DENIAL);
  });
});

test("without the unlock card in the browser, a carrier tab's dev tools are refused", async () => {
  await serve({}, async ({ call }) => {
    expect((await call("read_console", { id: "mail" })).text).toBe(DENIAL);
  });
});

test("harvest_widget on a widget with an account asks its card before any harvest, and its granted data is masked", async () => {
  const harvests: string[] = [];
  let cardsAtHarvest = -1;
  let current: FakeBridge | undefined;
  const widgets = {
    read: async (id: string) => (id === "banque" ? { name: "Banque", account: true, data: { iban: IBAN } } : null),
    harvest: async (id: string) => {
      harvests.push(id);
      cardsAtHarvest = current!.calls.filter((c) => c.method === "askWidgetData").length;
      return { status: "ok" as const, lastUpdate: "2026-11-23T10:00:00.000Z", lastAttempt: "2026-11-23T10:00:00.000Z" };
    },
    runs: async () => [],
    run: async () => null,
  } as unknown as WidgetsTools;
  await serve({ bridge: { widgetData: true }, widgets }, async ({ call, bridge }) => {
    current = bridge;
    const r = (await call("harvest_widget", { id: "banque" })).text;
    expect(harvests).toEqual(["banque"]);
    expect(cardsAtHarvest).toBe(1);
    expect(r).toMatch(/⟨iban-[a-z0-9]{8}⟩/);
    expect(windows(IBAN).filter((w) => r.includes(w))).toEqual([]);
  });
  await serve({ bridge: { widgetData: false }, widgets }, async ({ call }) => {
    harvests.length = 0;
    await call("harvest_widget", { id: "banque" });
    expect(harvests).toEqual([]);
  });
});

/** What a bank or webmail shows with the user's login: shapes the web zone leaves in clear. */
const MAIL = "camille.exemple@exemple-perso.fr";
const ACCOUNT = "12345678901";
const accountData = { titulaire: "Camille Exemple", tel: PHONE, mail: MAIL, compte: `compte ${ACCOUNT}` };
const RUN = "2026-11-23T10-00-00Z";
const inClear = (t: string) => [PHONE, MAIL, ACCOUNT].filter((v) => t.includes(v));

test("a widget read with the user's account comes out masked as a source: phone, e-mail, account number; a public one stays web", async () => {
  const run = { id: RUN, status: "succeeded", data: accountData };
  const widgets = {
    read: async (id: string) => ({ banque: { name: "Banque", account: true, data: accountData }, meteo: { name: "Météo", account: false, data: { tel: PHONE } } })[id] ?? null,
    harvest: async () => ({ status: "ok", lastUpdate: "2026-11-23T10:00:00.000Z", lastAttempt: "2026-11-23T10:00:00.000Z" }),
    runs: async () => [run],
    run: async () => run,
  } as unknown as WidgetsTools;
  await serve({ bridge: { widgetData: true }, widgets }, async ({ call }) => {
    for (const [name, args] of [["widget_data", {}], ["harvest_widget", {}], ["widget_runs", {}], ["widget_runs", { run: RUN }]] as const) {
      const t = (await call(name, { id: "banque", ...args })).text;
      expect(inClear(t), name).toEqual([]);
      expect(t, name).toMatch(/⟨tel-[a-z0-9]{8}⟩/);
    }
    // Owner-less public data keeps the web's masking: a phone there is no source of the user's.
    expect((await call("widget_data", { id: "meteo" })).text).toContain(PHONE);
  });
});

test("an action read with the user's account comes out masked as a source: its launch and its runs", async () => {
  const run = { id: RUN, status: "failed", data: accountData, plan: null };
  const actions = {
    read: async (id: string) => (id === "banque" ? { name: "Banque", account: true, input: null } : null),
    launch: async () => ({ status: "failed", run: RUN, error: `Échec pour ${MAIL}, tél ${PHONE}, compte ${ACCOUNT}` }),
    runs: async () => [run],
    run: async () => run,
  } as unknown as ActionsTools;
  await serve({ bridge: { widgetData: true }, actions }, async ({ call }) => {
    for (const [name, args] of [["launch_action", {}], ["action_runs", {}], ["action_runs", { run: RUN }]] as const) {
      const t = (await call(name, { id: "banque", ...args })).text;
      expect(inClear(t), name).toEqual([]);
      expect(t, name).toMatch(/⟨tel-[a-z0-9]{8}⟩/);
    }
  });
});

test("a site app's tweak errors are its user's source: a phone in them comes out masked", async () => {
  const sites = {
    list: async () => [{ id: "banque", name: "Banque", domain: "banque.example", open: true }],
    errors: async () => [{ when: "t", text: `Échec pour ${PHONE}`, source: "ressac-tweak://banque/a.js:1" }],
  } as unknown as SitesTools;
  await serve({ bridge: { widgetData: true }, sites }, async ({ call }) => {
    const t = (await call("tweak_errors", { id: "banque" })).text;
    expect(t).not.toContain(PHONE);
    expect(t).toMatch(/⟨tel-[a-z0-9]{8}⟩/);
  });
});

test("a fill of the user's value makes the tab a carrier: the next capture is refused (the value sits in an input)", async () => {
  await serve({ bridge: { fill: { yes: true } } }, async ({ call, bridge, page }) => {
    page("mail", `Ton IBAN : ${IBAN}`);
    bridge.pages.set("news", { text: "Formulaire de virement", fields: [{ handle: "9:0", type: "text", autocomplete: "", label: "IBAN" }] });
    const label = (await call("read_tab", { id: "mail" })).text.match(/⟨iban-[a-z0-9]{8}⟩/)![0];
    await call("read_tab", { id: "news" });
    expect((await call("fill_field", { id: "news", field: 0, value: label })).text).toBe("Champ rempli.");
    expect((await call("capture_screen", { id: "news" })).text).toBe(REFUSED);
    expect(captures(bridge)).toBe(0);
  });
});

test("the dev tools lock is per origin in the conversation: a plain tab on a carrier's origin asks the card", async () => {
  const plain: TabInfo = { id: "plain", title: "Autre page", url: "https://news.test/c", space: "perso", agentReached: true };
  await serve({ bridge: { devUnlock: false }, tabs: [mail, news, plain] }, async ({ call, page, bridge, policy }) => {
    page("news", `Carte ${CARD}`);
    page("plain", "Rien ici.");
    expect((await call("capture_screen", { id: "news" })).text).toBe(REFUSED);
    // Capture stays per tab.
    expect((await call("capture_screen", { id: "plain" })).image).toBe(true);
    expect((await call("run_js", { id: "plain", code: "1" })).text).toBe(DENIAL);
    expect(unlockCards(bridge)).toHaveLength(1);
    expect(bridge.calls.some((c) => c.method === "run")).toBe(false);
    // A new conversation forgets the origin; the carrier tab itself stays locked until closed.
    policy.reset();
    expect((await call("run_js", { id: "plain", code: "1" })).text).toBe('{"code":"1"}');
  });
});

test("a capture is refused when a frame of the page is a sensitive origin", async () => {
  await serve({}, async ({ call, bridge }) => {
    bridge.pages.set("news", { text: "Les nouvelles du jour.", frameOrigins: ["https://news.test", HOST] });
    expect((await call("capture_screen", { id: "news" })).text).toBe(REFUSED);
  });
  await serve({}, async ({ call, bridge }) => {
    bridge.pages.set("news", { text: "Les nouvelles du jour.", frameOrigins: ["https://news.test", "https://pub.test"] });
    expect((await call("capture_screen", { id: "news" })).image).toBe(true);
  });
});

test("a page that shows the data during the capture: the image is dropped", async () => {
  await serve({}, async ({ call, bridge, page }) => {
    const capture = bridge.capture.bind(bridge);
    bridge.capture = async (id, o) => {
      const png = await capture(id, o);
      page("news", `Virement vers ${IBAN}`);
      return png;
    };
    const r = await call("capture_screen", { id: "news" });
    expect(r).toEqual({ text: REFUSED, image: false, isError: false });
  });
});

test("a tab that leaves its origin during the unlock card stays locked", async () => {
  await serve({}, async ({ call, bridge, page }) => {
    page("news", `Carte ${CARD}`);
    bridge.askDevUnlock = async () => {
      bridge.editTab("news", { url: "https://other.test/" });
      return true;
    };
    expect((await call("read_console", { id: "news" })).text).toBe(DENIAL);
    expect(bridge.calls.some((c) => c.method === "console")).toBe(false);
  });
});

test("a capture is refused when a value the read leaves out shows: a field's value, a frame of another site", async () => {
  // A card number typed into a plain input: the page's text never holds it.
  await serve({}, async ({ call, bridge }) => {
    bridge.pages.set("news", { text: "Paiement", documents: [{ origin: "https://news.test", text: CARD }] });
    expect((await call("capture_screen", { id: "news" })).text).toBe(REFUSED);
    expect(captures(bridge)).toBe(0);
  });
  // A payroll frame of another (not listed) site showing an IBAN.
  await serve({}, async ({ call, bridge }) => {
    bridge.pages.set("news", { text: "Intranet", frameOrigins: ["https://news.test", "https://paie.test"], documents: [{ origin: "https://paie.test", text: `IBAN ${IBAN}` }] });
    expect((await call("capture_screen", { id: "news" })).text).toBe(REFUSED);
  });
  // The same frame with nothing private: the capture goes.
  await serve({}, async ({ call, bridge }) => {
    bridge.pages.set("news", { text: "Intranet", documents: [{ origin: "https://paie.test", text: "Bulletins de paie" }] });
    expect((await call("capture_screen", { id: "news" })).image).toBe(true);
  });
});

test("a capture is refused when a document could not be read, or when the browser cannot say (fail closed)", async () => {
  await serve({}, async ({ call, bridge }) => {
    bridge.pages.set("news", { text: "Les nouvelles du jour.", unread: true });
    expect((await call("capture_screen", { id: "news" })).text).toBe(REFUSED);
  });
  await serve({}, async ({ call, bridge }) => {
    (bridge as { carrierText?: unknown }).carrierText = undefined;
    expect((await call("capture_screen", { id: "news" })).text).toBe(REFUSED);
    expect(captures(bridge)).toBe(0);
  });
});

test("a value Ressac filled on an origin makes a page of that origin printing it back a carrier, in a frame too; a page of another origin printing it does not", async () => {
  const ADDRESS = "14 rue des Tanneurs\n69005 Lyon";
  const store = new PassportStore();
  store.replace("perso", [{ id: "00000000000000a1", field: "adresse", value: { text: ADDRESS }, variants: [], origins: ["boutique.example"], how: "typed", created: "2026-11-23T10:00:00.000Z", updated: "2026-11-23T10:00:00.000Z" }]);
  const ag: TabInfo = { id: "ag", title: "Commande", url: "https://boutique.example/commande", space: "perso", profile: "perso", agentReached: true };
  const conf: TabInfo = { id: "conf", title: "Confirmation", url: "https://boutique.example/commande/confirmation", space: "perso", profile: "perso", agentReached: true };
  const elsewhere: TabInfo = { id: "elsewhere", title: "Ailleurs", url: "https://ailleurs.example/", space: "perso", profile: "perso", agentReached: true };
  const bridge = new FakeBridge([ag, conf, elsewhere], { active: "ag", allow: true, address: true, fill: { yes: true }, devTools: true });
  bridge.pages.set("ag", { text: "Votre commande", links: [], fields: [{ handle: "5:0", type: "text", autocomplete: "", label: "Adresse" }] });
  const printed = "Merci ! Livraison : 14 rue des Tanneurs, 69005 Lyon.";
  bridge.pages.set("conf", { text: printed, links: [] });
  bridge.pages.set("elsewhere", { text: "Accueil", links: [], documents: [{ origin: "https://boutique.example", text: printed }] });
  const masker = new Masker({ passport: store });
  const s = await startMcpServer({ lab: () => true, bridge, policy: new AccessPolicy(), token: generateToken(), masker, locale: () => "fr" });
  masker.open("A", "W1");
  const session = s.openSession("W1", undefined, "A");
  const c = new Client({ name: "t", version: "0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${s.port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${session}` } } }));
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await c.callTool({ name, arguments: args });
    const content = r.content as { type: string; text?: string }[];
    return { text: content.map((x) => x.text ?? "").join("\n"), image: content.some((x) => x.type === "image") };
  };
  try {
    // Before the fill the address is nobody's value on this web page: the capture goes.
    expect((await call("capture_screen", { id: "conf" })).image).toBe(true);
    await call("read_tab", { id: "ag" });
    expect((await call("fill_field", { id: "ag", field: 0, passport: "adresse" })).text).toBe("Champ rempli.");
    expect((await call("read_tab", { id: "conf" })).text).not.toContain("Tanneurs");
    expect((await call("capture_screen", { id: "conf" })).text).toBe(REFUSED);
    // A frame of the filled origin printing it, inside another site's page.
    expect((await call("capture_screen", { id: "elsewhere" })).text).toBe(REFUSED);
  } finally {
    await c.close();
    await s.stop();
  }
});

test("a value filled on one origin does not make another origin's page printing it a carrier (no oracle there)", async () => {
  const ADDRESS = "14 rue des Tanneurs\n69005 Lyon";
  const store = new PassportStore();
  store.replace("perso", [{ id: "00000000000000a1", field: "adresse", value: { text: ADDRESS }, variants: [], origins: ["boutique.example"], how: "typed", created: "2026-11-23T10:00:00.000Z", updated: "2026-11-23T10:00:00.000Z" }]);
  const ag: TabInfo = { id: "ag", title: "Commande", url: "https://boutique.example/commande", space: "perso", profile: "perso", agentReached: true };
  const other: TabInfo = { id: "other", title: "Autre", url: "https://autre.example/", space: "perso", profile: "perso", agentReached: true };
  const bridge = new FakeBridge([ag, other], { active: "ag", allow: true, address: true, fill: { yes: true }, devTools: true });
  bridge.pages.set("ag", { text: "Votre commande", links: [], fields: [{ handle: "5:0", type: "text", autocomplete: "", label: "Adresse" }] });
  bridge.pages.set("other", { text: "Livraison : 14 rue des Tanneurs, 69005 Lyon.", links: [] });
  const masker = new Masker({ passport: store });
  const s = await startMcpServer({ lab: () => true, bridge, policy: new AccessPolicy(), token: generateToken(), masker, locale: () => "fr" });
  masker.open("A", "W1");
  const session = s.openSession("W1", undefined, "A");
  const c = new Client({ name: "t", version: "0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${s.port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${session}` } } }));
  try {
    await c.callTool({ name: "read_tab", arguments: { id: "ag" } });
    await c.callTool({ name: "fill_field", arguments: { id: "ag", field: 0, passport: "adresse" } });
    const r = await c.callTool({ name: "capture_screen", arguments: { id: "other" } });
    expect((r.content as { type: string }[]).some((x) => x.type === "image")).toBe(true);
  } finally {
    await c.close();
    await s.stop();
  }
});

/** A user's tab on a passport host: a source whose visible text shows no value of the user's. */
const nameStore = () => {
  const store = new PassportStore();
  store.replace("perso", [{ id: "00000000000000d4", field: "nom", value: { given: "Camille", family: "Aubrac" }, variants: [], origins: ["boutique.example"], how: "typed", created: "2026-11-23T10:00:00.000Z", updated: "2026-11-23T10:00:00.000Z" }]);
  return store;
};
const cart: TabInfo = { id: "cart", title: "Panier", url: "https://boutique.example/panier", space: "perso", profile: "perso", agentReached: false };

async function serveCart(o: { devUnlock: boolean }, attempt: (x: { call: (name: string, args: Record<string, unknown>) => Promise<string>; bridge: FakeBridge }) => Promise<void>) {
  const bridge = new FakeBridge([cart, news], { active: "cart", allow: true, devTools: true, grantDev: [...DEV_RIGHTS], devUnlock: o.devUnlock });
  bridge.pages.set("cart", { text: "Votre panier : 2 articles.", links: [] });
  bridge.pages.set("news", { text: "Les nouvelles du jour.", links: [] });
  const masker = new Masker({ passport: nameStore() });
  const s = await startMcpServer({ lab: () => true, bridge, policy: new AccessPolicy(), token: generateToken(), masker, locale: () => "fr", agent: "Claude" });
  masker.open("A", "W1");
  const session = s.openSession("W1", undefined, "A");
  const c = new Client({ name: "t", version: "0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${s.port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${session}` } } }));
  const call = async (name: string, args: Record<string, unknown>) => ((await c.callTool({ name, arguments: args })).content as { text?: string }[]).map((x) => x.text ?? "").join("\n");
  try {
    await attempt({ call, bridge });
  } finally {
    await c.close();
    await s.stop();
  }
}
const LOG = `client : Camille Aubrac · tel ${PHONE}`;

test("dev tools on a sources tab that shows nothing ask the unlock card; refused, nothing is read nor run", async () => {
  await serveCart({ devUnlock: false }, async ({ call, bridge }) => {
    bridge.setConsole("cart", [{ level: "log", text: LOG, timestamp: 1 }]);
    expect(await call("read_console", { id: "cart" })).toBe(DENIAL);
    expect(await call("run_js", { id: "cart", code: "document.body.innerText = 'Lucie Ferrand\\nCamille Aubrac'" })).toBe(DENIAL);
    expect(unlockCards(bridge).length).toBeGreaterThan(0);
    expect(bridge.calls.some((c) => c.method === "console" || c.method === "run")).toBe(false);
  });
});

test("dev tools output on a tab is masked in that tab's zone and origin: a sources tab's log, once unlocked, keeps the user's name and phone masked", async () => {
  await serveCart({ devUnlock: true }, async ({ call, bridge }) => {
    bridge.setConsole("cart", [{ level: "log", text: LOG, timestamp: 1 }]);
    const out = await call("read_console", { id: "cart" });
    expect(out).not.toContain("Aubrac");
    expect(out).not.toContain(PHONE);
    expect(out).toMatch(/⟨tel-[a-z0-9]{8}⟩/);
  });
});

test("dev tools on a web tab ask no unlock card and stay in clear there (no oracle)", async () => {
  await serveCart({ devUnlock: false }, async ({ call, bridge }) => {
    bridge.setConsole("news", [{ level: "log", text: LOG, timestamp: 1 }]);
    expect(await call("read_console", { id: "news" })).toContain("Camille Aubrac");
    expect(unlockCards(bridge)).toHaveLength(0);
  });
});

/** The user's shop tab; while the read card is up the user goes to their account page (same origin, sensitive by path). */
async function movedDuringCard(tool: "read_tab" | "capture_screen", moveTo: string | null, always = false) {
  const contact = `Vos coordonnées\nTéléphone : ${PHONE}`;
  const shop: TabInfo = { id: "shop", title: "Boutique", url: "https://shop.example/", space: "perso", agentReached: false };
  const bridge = new FakeBridge([shop], { active: "other", allow: true });
  bridge.pages.set("shop", { text: contact, links: [] });
  const ask = bridge.askPermission.bind(bridge);
  bridge.askPermission = async (o, signal) => {
    if (moveTo) bridge.editTab("shop", { url: moveTo });
    return ask(o, signal);
  };
  // A page that never settles (a redirect loop within its origin): every look at the tab finds a new address.
  let hops = 0;
  const list = bridge.listTabs.bind(bridge);
  if (always) bridge.listTabs = async () => (bridge.editTab("shop", { url: `https://shop.example/page/${++hops}` }), list());
  const masker = new Masker();
  const s = await startMcpServer({ lab: () => true, bridge, policy: new AccessPolicy(), token: generateToken(), masker, locale: () => "fr" });
  masker.open("A", "W1");
  const session = s.openSession("W1", undefined, "A");
  const c = new Client({ name: "t", version: "0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${s.port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${session}` } } }));
  try {
    const r = await c.callTool({ name: tool, arguments: { id: "shop" } });
    const content = r.content as { type: string; text?: string }[];
    return { text: content.map((x) => x.text ?? "").join("\n"), image: content.some((x) => x.type === "image") };
  } finally {
    await c.close();
    await s.stop();
  }
}

test("a tab that moves within its origin to a sensitive page while the read card is up is read and captured as that page", async () => {
  const read = await movedDuringCard("read_tab", "https://shop.example/compte/coordonnees");
  expect(read.text).not.toContain(PHONE);
  expect(read.text).toContain("https://shop.example/compte/coordonnees");
  expect((await movedDuringCard("capture_screen", "https://shop.example/compte/coordonnees")).image).toBe(false);
  // Control: staying on the shop's home, the phone is the web's.
  expect((await movedDuringCard("read_tab", null)).text).toContain(PHONE);
});

test("a tab that moves within its origin during the read itself is masked as the page the browser read", async () => {
  const shop: TabInfo = { id: "shop", title: "Boutique", url: "https://shop.example/", space: "perso", agentReached: false };
  await serve({ tabs: [shop] }, async ({ call, bridge }) => {
    bridge.pages.set("shop", { text: `Téléphone : ${PHONE}` });
    const read = bridge.readText.bind(bridge);
    bridge.readText = async (id, o) => {
      bridge.editTab("shop", { url: "https://shop.example/compte/coordonnees" });
      return read(id, o);
    };
    expect((await call("read_tab", { id: "shop" })).text).not.toContain(PHONE);
  });
});

test("a tab that keeps moving on every card is not read, and the agent is not told the user refused", async () => {
  for (const tool of ["read_tab", "capture_screen"] as const) {
    const r = await movedDuringCard(tool, "https://shop.example/page", true);
    expect(r.text).toBe(MOVING_TEXT);
    expect(r.image).toBe(false);
  }
});
