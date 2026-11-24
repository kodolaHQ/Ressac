import { expect, test, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AccessPolicy } from "../../src/access/policy.js";
import type { TabInfo } from "../../src/mcp/bridge.js";
import { FakeBridge } from "../../src/mcp/fake-bridge.js";
import { generateToken, startMcpServer } from "../../src/mcp/server.js";
import { Masker } from "../../src/mask/masker.js";
import { maskedDisplay, type PassportEntry, type PassportField, type PassportValue } from "../../src/mask/passport-fields.js";
import { PassportStore } from "../../src/mask/passport.js";
import { Outflow } from "../../src/outflow/outflow.js";
import { CODE, IBAN, PHONE } from "../mask/values.js";

const HOST = "https://mail.example-novacourriel.test";
const COPY = "https://copie.test";
const FIELDS = [
  { handle: "7:0", type: "text", autocomplete: "one-time-code", label: "Code reçu" },
  { handle: "7:1", type: "password", autocomplete: "current-password", label: "Mot de passe" },
  { handle: "7:2", type: "text", autocomplete: "username", label: "Identifiant" },
];
const user: TabInfo = { id: "mail", title: "Ma banque", url: `${HOST}/connexion`, space: "perso", agentReached: false };
const copy: TabInfo = { id: "copie", title: "Copie", url: `${COPY}/form`, space: "perso", agentReached: true };
const UNKNOWN = "Étiquette d'une conversation précédente ou inconnue : relis la page.";
const BLOCKED = "Remplissage bloqué pour cette conversation : trop d'étiquettes inconnues. Une nouvelle conversation le débloque.";
const CHANGED = "Le champ a changé avant le remplissage : rien n'a été écrit. Redemande.";
const SAVED_LOGIN = "Le mot de passe enregistré ne se remplit que sur son site exact, dans un champ mot de passe ou identifiant, sans cadre ni formulaire d'un autre site.";
const WRONG_ORIGIN = "Cette étiquette ne se remplit que sur le site où sa valeur a été lue.";
const LOCKED = "Conversation verrouillée : votre code a été révélé. Cette sortie demande votre accord.";

type Opts = ConstructorParameters<typeof FakeBridge>[1];
type Call = (name: string, args: Record<string, unknown>) => Promise<{ text: string; isError: boolean }>;
type Ctx = { call: Call; bridge: FakeBridge; masker: Masker; results: string[]; label: () => Promise<string>; of: (m: string) => unknown[][] };

async function serve(o: { bridge?: Partial<Opts>; outflow?: Outflow }, attempt: (x: Ctx) => Promise<void>) {
  const bridge = new FakeBridge([user, copy], { active: "mail", allow: true, address: true, reveal: true, fill: { yes: true }, ...o.bridge });
  bridge.pages.set("mail", { text: `Ton code : ${CODE}. Ton IBAN : ${IBAN}. Rappel au ${PHONE}.`, links: [], fields: FIELDS });
  bridge.pages.set("copie", { text: `Code affiché : ${CODE}`, links: [], fields: FIELDS.map((f) => ({ ...f, handle: `9:${f.handle.slice(2)}` })) });
  const token = generateToken();
  const masker = new Masker();
  const s = await startMcpServer({ bridge, policy: new AccessPolicy(), token, masker, locale: () => "fr", ...(o.outflow ? { outflow: o.outflow } : {}) });
  masker.open("A", "W1");
  const session = s.openSession("W1", undefined, "A");
  const clients: Client[] = [];
  const results: string[] = [];
  const call: Call = async (name, args) => {
    const c = new Client({ name: "test", version: "0" });
    clients.push(c);
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${s.port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${session}` } } }));
    const r = await c.callTool({ name, arguments: args });
    const text = (r.content as { text?: string }[]).map((x) => x.text ?? "").join("\n");
    results.push(text);
    return { text, isError: r.isError === true };
  };
  const label = async () => (await call("read_tab", { id: "mail" })).text.match(/⟨code-[a-z0-9]{8}⟩/)![0];
  const of = (m: string) => bridge.calls.filter((c) => c.method === m).map((c) => c.args);
  try {
    await attempt({ call, bridge, masker, results, label, of });
  } finally {
    await Promise.all(clients.map((c) => c.close()));
    await s.stop();
  }
}

test("a read lists the page's fields; a code label filled into a text field goes to commit after the card, never to the agent", async () => {
  await serve({}, async ({ call, bridge, results, of }) => {
    const read = (await call("read_tab", { id: "mail" })).text;
    expect(read).toContain('Champs (fill_field accepte {"field": n}) :\n0. text — Code reçu\n1. password — Mot de passe\n2. text — Identifiant');
    const l = read.match(/⟨code-[a-z0-9]{8}⟩/)![0];
    const r = await call("fill_field", { id: "mail", field: 0, value: `${l}` });
    expect(r).toEqual({ text: "Champ rempli.", isError: false });
    expect(of("fill.prepare")).toEqual([["mail", "7:0"]]);
    expect(of("askFill")[0]![0]).toEqual({ name: "votre code", field: "Code reçu", where: `${HOST}/connexion`, touchId: false, labels: [l], agent: "L'agent" });
    expect(of("fill.commit")[0]!.slice(1)).toEqual([{ text: CODE }, HOST]);
    expect(results.filter((x) => x.includes(CODE))).toEqual([]);
    expect(bridge.calls.some((c) => c.method === "askAddress")).toBe(false);
  });
});

test("a code label into a password field is allowed after its card", async () => {
  await serve({}, async ({ call, label, of }) => {
    const r = await call("fill_field", { id: "mail", field: 1, value: await label() });
    expect(r.text).toBe("Champ rempli.");
    expect(of("askFill")).toHaveLength(1);
    expect(of("fill.commit")[0]![1]).toEqual({ text: CODE });
  });
});

test("an IBAN label into a password field is refused before any card", async () => {
  await serve({}, async ({ call, of }) => {
    const l = (await call("read_tab", { id: "mail" })).text.match(/⟨iban-[a-z0-9]{8}⟩/)![0];
    const r = await call("fill_field", { id: "mail", field: 1, value: l });
    expect(r).toEqual({ text: "Ce champ est un mot de passe : seuls un code ou un mot de passe y vont.", isError: true });
    expect(of("askFill")).toEqual([]);
    expect(of("fill.commit")).toEqual([]);
  });
});

test("a password label into a text field is refused; into its password field on its origin, after the card", async () => {
  await serve({}, async ({ call, masker, of }) => {
    await call("read_tab", { id: "mail" });
    const l = masker.table("A").label("motdepasse", "phrase" + "-de-test", "sources", HOST);
    expect(await call("fill_field", { id: "mail", field: 0, value: l })).toEqual({ text: "Un mot de passe ne va que dans un champ mot de passe.", isError: true });
    expect(of("askFill")).toEqual([]);
    expect((await call("fill_field", { id: "mail", field: 1, value: l })).text).toBe("Champ rempli.");
    expect(of("fill.commit")[0]![1]).toEqual({ text: "phrase-de-test" });
  });
});

test("a web label fills only on the origin it was read on", async () => {
  await serve({}, async ({ call, of }) => {
    const web = (await call("read_tab", { id: "copie" })).text.match(/⟨code-[a-z0-9]{8}⟩/)![0];
    await call("read_tab", { id: "mail" });
    expect(await call("fill_field", { id: "mail", field: 0, value: web })).toEqual({ text: "Cette étiquette ne se remplit que sur le site où sa valeur a été lue.", isError: true });
    expect(of("askFill")).toEqual([]);
    expect((await call("fill_field", { id: "copie", field: 0, value: web })).text).toBe("Champ rempli.");
    // Tab reached by the agent: Touch ID on the card.
    expect(of("askFill")[0]![0]).toMatchObject({ name: "un code", touchId: true });
  });
});

test("a saved login with a cross-origin frame is refused with no card; on its exact origin, the card lists the logins", async () => {
  await serve({ bridge: { fill: { yes: true, login: 0 } } }, async ({ call, bridge, of }) => {
    await call("read_tab", { id: "mail" });
    bridge.seals.set("7:1", { frames: [HOST, "https://cadre.test"], logins: [{ username: "camille" }] });
    const r = await call("fill_field", { id: "mail", field: 1, saved_login: true });
    expect(r).toEqual({ text: SAVED_LOGIN, isError: true });
    expect(of("askFill")).toEqual([]);

    // A text field that is not a username one: refused too.
    bridge.seals.set("7:0", { logins: [{ username: "camille" }] });
    expect((await call("fill_field", { id: "mail", field: 0, saved_login: true })).isError).toBe(true);

    bridge.seals.set("7:1", { logins: [] });
    expect((await call("fill_field", { id: "mail", field: 1, saved_login: true })).text).toBe("Aucun identifiant enregistré pour ce site : rien n'a été rempli.");
    expect(of("askFill")).toEqual([]);

    bridge.seals.set("7:1", { logins: [{ username: "camille" }] });
    expect((await call("fill_field", { id: "mail", field: 1, saved_login: true })).text).toBe("Champ rempli.");
    expect(of("askFill")[0]![0]).toEqual({ name: "votre mot de passe", field: "Mot de passe", where: `${HOST}/connexion`, touchId: false, labels: [], logins: ["camille"], agent: "L'agent" });
    expect(of("fill.commit")[0]![1]).toEqual({ savedLogin: "password", login: 0 });
    bridge.seals.set("7:2", { logins: [{ username: "camille" }] });
    await call("fill_field", { id: "mail", field: 2, saved_login: true });
    expect(of("fill.commit")[1]![1]).toEqual({ savedLogin: "username", login: 0 });
  });
});

const CAMILLE = [{ username: "camille" }];

test("a saved login on a login form fills both fields from one call, on one card that names both", async () => {
  for (const field of [1, 2]) {
    await serve({ bridge: { fill: { yes: true, login: 0 } } }, async ({ call, bridge, of }) => {
      await call("read_tab", { id: "mail" });
      bridge.seals.set("7:1", { logins: CAMILLE, partner: "7:2" });
      bridge.seals.set("7:2", { logins: CAMILLE, partner: "7:1" });
      expect(await call("fill_field", { id: "mail", field, saved_login: true })).toEqual({ text: "Identifiant et mot de passe remplis.", isError: false });
      expect(of("askFill")).toHaveLength(1);
      expect(of("askFill")[0]![0]).toEqual({ name: "votre identifiant et votre mot de passe", field: "Identifiant, Mot de passe", where: `${HOST}/connexion`, touchId: false, labels: [], logins: ["camille"], agent: "L'agent" });
      const kinds = of("fill.commit").map((c) => c[1]);
      expect(kinds).toEqual(field === 1 ? [{ savedLogin: "password", login: 0 }, { savedLogin: "username", login: 0 }] : [{ savedLogin: "username", login: 0 }, { savedLogin: "password", login: 0 }]);
    });
  }
});

test("a form with only one login field fills that one, as before", async () => {
  await serve({}, async ({ call, bridge, of }) => {
    await call("read_tab", { id: "mail" });
    bridge.seals.set("7:2", { logins: CAMILLE });
    expect((await call("fill_field", { id: "mail", field: 2, saved_login: true })).text).toBe("Champ rempli.");
    expect(of("fill.prepare")).toEqual([["mail", "7:2"]]);
    expect(of("askFill")[0]![0]).toMatchObject({ name: "votre identifiant", field: "Identifiant" });
    expect(of("fill.commit").map((c) => c[1])).toEqual([{ savedLogin: "username" }]);
  });
});

test("the other field fills only under every rule of its own: else the field asked fills alone", async () => {
  const cases: [string, Record<string, unknown>][] = [
    ["a frame of another origin", { frames: [HOST, "https://cadre.test"] }],
    ["an empty frame chain", { frames: [] }],
    ["a form posting elsewhere", { action: EVIL_ACTION }],
    ["another origin", { origin: COPY }],
    ["not the field the read listed", { type: "email" }],
    ["other saved logins", { logins: [{ username: "autre" }] }],
  ];
  for (const [what, partner] of cases) {
    await serve({}, async ({ call, bridge, of }) => {
      await call("read_tab", { id: "mail" });
      bridge.seals.set("7:1", { logins: CAMILLE, partner: "7:2" });
      bridge.seals.set("7:2", { logins: CAMILLE, ...partner });
      expect((await call("fill_field", { id: "mail", field: 1, saved_login: true })).text, what).toBe("Champ rempli.");
      expect(of("askFill")[0]![0], what).toMatchObject({ name: "votre mot de passe", field: "Mot de passe" });
      expect(of("fill.commit").map((c) => c[1]), what).toEqual([{ savedLogin: "password" }]);
    });
  }
  // Two password fields (the partner is not a username one), or a text field that is no username: never the pair.
  await serve({}, async ({ call, bridge, of }) => {
    await call("read_tab", { id: "mail" });
    bridge.seals.set("7:1", { logins: CAMILLE, partner: "7:0" });
    expect((await call("fill_field", { id: "mail", field: 1, saved_login: true })).text).toBe("Champ rempli.");
    expect(of("fill.commit")).toHaveLength(1);
  });
});

/** A login form whose username field has no `autocomplete`: only Firefox's pairing makes it the username. */
const PLAIN = [
  { handle: "7:0", type: "text", autocomplete: "", label: "Identifiant" },
  { handle: "7:1", type: "password", autocomplete: "", label: "Mot de passe" },
];

test("a login form whose username field has no autocomplete fills both, from either field, when Firefox pairs them both ways", async () => {
  for (const field of [0, 1]) {
    await serve({}, async ({ call, bridge, of }) => {
      bridge.pages.set("mail", { text: "Connexion", links: [], fields: PLAIN });
      await call("read_tab", { id: "mail" });
      bridge.seals.set("7:0", { logins: CAMILLE, partner: "7:1" });
      bridge.seals.set("7:1", { logins: CAMILLE, partner: "7:0" });
      expect((await call("fill_field", { id: "mail", field, saved_login: true })).text).toBe("Identifiant et mot de passe remplis.");
      expect(of("askFill")[0]![0]).toMatchObject({ name: "votre identifiant et votre mot de passe", field: "Identifiant, Mot de passe" });
      expect(of("fill.commit").map((c) => (c[1] as { savedLogin: string }).savedLogin).sort()).toEqual(["password", "username"]);
    });
  }
});

test("a username field without autocomplete gets nothing alone: no password field, a pairing one way only, or a password field failing its rules", async () => {
  const cases: [string, Record<string, unknown>][] = [
    ["no password field", {}],
    ["not paired back", { partner: "7:1", other: {} }],
    ["the password's form posts elsewhere", { partner: "7:1", other: { partner: "7:0", action: EVIL_ACTION } }],
  ];
  for (const [what, c] of cases) {
    await serve({}, async ({ call, bridge, of }) => {
      bridge.pages.set("mail", { text: "Connexion", links: [], fields: c.partner ? PLAIN : PLAIN.slice(0, 1) });
      await call("read_tab", { id: "mail" });
      bridge.seals.set("7:0", { logins: CAMILLE, ...(c.partner ? { partner: c.partner as string } : {}) });
      bridge.seals.set("7:1", { logins: CAMILLE, ...(c.other as object) });
      expect(await call("fill_field", { id: "mail", field: 0, saved_login: true }), what).toEqual({ text: SAVED_LOGIN, isError: true });
      expect(of("askFill"), what).toEqual([]);
      expect(of("fill.commit"), what).toEqual([]);
    });
  }
  // From the password field, paired one way only: the password fills alone, the plain text field never.
  await serve({}, async ({ call, bridge, of }) => {
    bridge.pages.set("mail", { text: "Connexion", links: [], fields: PLAIN });
    await call("read_tab", { id: "mail" });
    bridge.seals.set("7:1", { logins: CAMILLE, partner: "7:0" });
    bridge.seals.set("7:0", { logins: CAMILLE });
    expect((await call("fill_field", { id: "mail", field: 1, saved_login: true })).text).toBe("Champ rempli.");
    expect(of("fill.commit").map((c) => c[1])).toEqual([{ savedLogin: "password" }]);
  });
});

test("a partner past the 40 fields of the read is never filled", async () => {
  await serve({}, async ({ call, bridge, of }) => {
    const more = Array.from({ length: 40 }, (_, i) => ({ handle: `7:${i + 3}`, type: "text", autocomplete: "", label: `Champ ${i}` }));
    bridge.pages.set("mail", { text: "Connexion", links: [], fields: [...FIELDS, ...more, { handle: "7:99", type: "text", autocomplete: "username", label: "Identifiant" }] });
    await call("read_tab", { id: "mail" });
    bridge.seals.set("7:1", { logins: CAMILLE, partner: "7:99" });
    expect((await call("fill_field", { id: "mail", field: 1, saved_login: true })).text).toBe("Champ rempli.");
    expect(of("fill.prepare")).toEqual([["mail", "7:1"]]);
    expect(of("fill.commit")).toHaveLength(1);
  });
});

test("the pair: a refused card fills neither; a page the agent reached asks Touch ID; a partner changed at commit is told", async () => {
  await serve({ bridge: { fill: { yes: false } } }, async ({ call, bridge, of }) => {
    await call("read_tab", { id: "mail" });
    bridge.seals.set("7:1", { logins: CAMILLE, partner: "7:2" });
    bridge.seals.set("7:2", { logins: CAMILLE, partner: "7:1", agentReached: true });
    expect((await call("fill_field", { id: "mail", field: 1, saved_login: true })).text).toBe("L'utilisateur a refusé ce remplissage : rien n'a été écrit.");
    expect(of("askFill")[0]![0]).toMatchObject({ touchId: true });
    expect(of("fill.commit")).toEqual([]);
  });
  await serve({}, async ({ call, bridge, of }) => {
    await call("read_tab", { id: "mail" });
    bridge.seals.set("7:1", { logins: CAMILLE, partner: "7:2" });
    bridge.seals.set("7:2", { logins: CAMILLE });
    bridge.fillAnswers = ["filled", "changed"];
    expect(await call("fill_field", { id: "mail", field: 1, saved_login: true })).toEqual({ text: "Champ rempli ; l'autre champ de connexion a changé et n'a pas été rempli : relis l'onglet avec read_tab.", isError: false });
    bridge.fillAnswers = ["changed"];
    expect((await call("fill_field", { id: "mail", field: 1, saved_login: true })).isError).toBe(true);
    // The field asked changed: its partner is never written.
    expect(of("fill.commit")).toHaveLength(3);
  });
});

test("three unknown labels block fill_field and reveal_value: the third answers the blocked text, the fourth never reaches the browser", async () => {
  await serve({}, async ({ call, bridge, masker, label, of }) => {
    const good = await label();
    const bad = (n: number) => call("fill_field", { id: "mail", field: 0, value: `x ⟨code-zzzzzzz${n}⟩` });
    expect(await bad(1)).toEqual({ text: UNKNOWN, isError: true });
    expect(await bad(2)).toEqual({ text: UNKNOWN, isError: true });
    expect(await bad(3)).toEqual({ text: BLOCKED, isError: true });
    expect(bridge.calls.filter((c) => c.method === "askLockNotice").map((c) => c.args[0])).toEqual([{ text: BLOCKED }]);
    const prepared = of("fill.prepare").length;
    expect(await call("fill_field", { id: "mail", field: 0, value: good })).toEqual({ text: BLOCKED, isError: true });
    expect(of("fill.prepare")).toHaveLength(prepared);
    expect(await call("reveal_value", { label: good, reason: "payer" })).toEqual({ text: BLOCKED, isError: true });
    expect(of("askReveal")).toEqual([]);
    expect(of("fill.commit")).toEqual([]);
    expect(masker.lock("A").unknownLabels).toBeGreaterThanOrEqual(3);
  });
});

test("a well-formed label from an earlier conversation is unknown, and counted", async () => {
  await serve({}, async ({ call, masker, of }) => {
    await call("read_tab", { id: "mail" });
    masker.open("B", "W2");
    const stale = masker.table("B").label("code", CODE, "sources", HOST);
    masker.close("B");
    expect(await call("fill_field", { id: "mail", field: 0, value: stale })).toEqual({ text: UNKNOWN, isError: true });
    expect(masker.lock("A").unknownLabels).toBe(1);
    expect(of("fill.commit")).toEqual([]);
  });
});

test("free text holding a phone the agent read in clear asks the card, with the outflow's red line", async () => {
  await serve({ outflow: new Outflow() }, async ({ call, bridge, of }) => {
    // The web zone leaves a phone in clear.
    bridge.pages.set("copie", { text: `Rappel au ${PHONE}`, links: [], fields: [] });
    expect((await call("read_tab", { id: "copie" })).text).toContain(PHONE);
    await call("read_tab", { id: "mail" });
    await call("fill_field", { id: "mail", field: 0, value: `rappelle le ${PHONE}` });
    const card = of("askFill")[0]![0] as { danger?: string };
    expect(card.danger).toBeDefined();
    expect(card.danger).not.toContain(PHONE);
  });
});

test("free text holding a phone the agent saw only as its label fills with no card: rule 2 is no oracle on it", async () => {
  await serve({ outflow: new Outflow() }, async ({ call, of }) => {
    expect((await call("read_tab", { id: "mail" })).text).not.toContain(PHONE);
    expect((await call("fill_field", { id: "mail", field: 0, value: `rappelle le ${PHONE}` })).text).toBe("Champ rempli.");
    expect(of("askFill")).toEqual([]);
  });
});

test("free text with nothing behind it fills with no card", async () => {
  await serve({}, async ({ call, of }) => {
    await call("read_tab", { id: "mail" });
    expect((await call("fill_field", { id: "mail", field: 0, value: "bonjour" })).text).toBe("Champ rempli.");
    expect(of("askFill")).toEqual([]);
    expect(of("fill.commit")[0]![1]).toEqual({ text: "bonjour" });
  });
});

test("a field that changed before the commit: no value in the result, and the next fill asks the card again", async () => {
  await serve({}, async ({ call, bridge, results, label, of }) => {
    const l = await label();
    bridge.fillAnswers.push("changed");
    expect(await call("fill_field", { id: "mail", field: 0, value: l })).toEqual({ text: CHANGED, isError: true });
    expect((await call("fill_field", { id: "mail", field: 0, value: l })).text).toBe("Champ rempli.");
    expect(of("askFill")).toHaveLength(2);
    expect(results.filter((x) => x.includes(CODE))).toEqual([]);
  });
});

test("under a lock, a fill toward another origin shows one card, the fill card with the lock line; refused, nothing written", async () => {
  await serve({ bridge: { fill: { yes: false } } }, async ({ call, bridge, label, of }) => {
    await call("reveal_value", { label: await label(), reason: "payer" });
    await call("read_tab", { id: "copie" });
    const asked = bridge.calls.filter((c) => c.method === "askAddress").length;
    const r = await call("fill_field", { id: "copie", field: 0, value: "bonjour" });
    expect(r.text).toBe("Conversation verrouillée : cette sortie n'a pas reçu votre accord.");
    expect(of("askFill")).toHaveLength(1);
    expect((of("askFill")[0]![0] as { danger?: string }).danger).toBe(LOCKED);
    expect(bridge.calls.filter((c) => c.method === "askAddress")).toHaveLength(asked);
    expect(of("fill.commit")).toEqual([]);
  });
});

test("an unknown field number, a navigation, or both value and saved_login: an error, nothing prepared", async () => {
  await serve({}, async ({ call, of }) => {
    await call("read_tab", { id: "mail" });
    expect((await call("fill_field", { id: "mail", field: 9, value: "x" })).isError).toBe(true);
    expect((await call("fill_field", { id: "mail", field: 0, value: "x", saved_login: true })).isError).toBe(true);
    await call("navigate", { id: "mail", url: `${HOST}/autre`, reason: "r" });
    expect((await call("fill_field", { id: "mail", field: 0, value: "x" })).isError).toBe(true);
    expect(of("fill.prepare")).toEqual([]);
  });
});

const EVIL_ACTION = "https://evil.test/steal";

test("a saved login whose form posts to another origin, or with an empty frame chain, is refused with no card", async () => {
  for (const seal of [{ action: EVIL_ACTION }, { frames: [] }]) {
    await serve({}, async ({ call, bridge, of }) => {
      await call("read_tab", { id: "mail" });
      bridge.seals.set("7:1", { ...seal, logins: [{ username: "camille" }] });
      expect(await call("fill_field", { id: "mail", field: 1, saved_login: true })).toEqual({ text: SAVED_LOGIN, isError: true });
      expect(of("askFill")).toEqual([]);
      expect(of("fill.commit")).toEqual([]);
    });
  }
});

test("a form posting to its own origin is no destination elsewhere: the saved login fills", async () => {
  await serve({}, async ({ call, bridge, of }) => {
    await call("read_tab", { id: "mail" });
    bridge.seals.set("7:1", { action: `${HOST}/session`, logins: [{ username: "camille" }] });
    expect((await call("fill_field", { id: "mail", field: 1, saved_login: true })).text).toBe("Champ rempli.");
    expect(of("fill.commit")).toHaveLength(1);
  });
});

test("a password label or a web label in a form posting elsewhere is refused before any card", async () => {
  await serve({}, async ({ call, bridge, masker, of }) => {
    const web = (await call("read_tab", { id: "copie" })).text.match(/⟨code-[a-z0-9]{8}⟩/)![0];
    bridge.seals.set("9:0", { action: EVIL_ACTION });
    expect(await call("fill_field", { id: "copie", field: 0, value: web })).toEqual({ text: WRONG_ORIGIN, isError: true });
    await call("read_tab", { id: "mail" });
    const pw = masker.table("A").label("motdepasse", "phrase" + "-de-test", "sources", HOST);
    bridge.seals.set("7:1", { action: EVIL_ACTION });
    expect(await call("fill_field", { id: "mail", field: 1, value: pw })).toEqual({ text: WRONG_ORIGIN, isError: true });
    expect(of("askFill")).toEqual([]);
  });
});

test("another label in a form posting elsewhere gets a red line naming where it goes", async () => {
  await serve({}, async ({ call, bridge, label, of }) => {
    const l = await label();
    bridge.seals.set("7:0", { action: EVIL_ACTION });
    expect((await call("fill_field", { id: "mail", field: 0, value: l })).text).toBe("Champ rempli.");
    expect((of("askFill")[0]![0] as { danger?: string }).danger).toBe("Ce formulaire envoie vers https://evil.test, pas vers le site du champ.");
  });
});

test("under the lock, a fill on the allowed origin whose form posts elsewhere asks the locked card", async () => {
  await serve({ bridge: { fill: { yes: false } } }, async ({ call, bridge, label, of }) => {
    await call("reveal_value", { label: await label(), reason: "payer" });
    bridge.seals.set("7:0", { action: EVIL_ACTION });
    const r = await call("fill_field", { id: "mail", field: 0, value: "bonjour" });
    expect(r.text).toBe("Conversation verrouillée : cette sortie n'a pas reçu votre accord.");
    expect((of("askFill")[0]![0] as { danger?: string }).danger).toBe(LOCKED);
    expect(of("fill.commit")).toEqual([]);
  });
});

test("a sealed field that is not the one read (type or autocomplete) counts as changed: no card, nothing written", async () => {
  for (const seal of [{ type: "password" }, { autocomplete: "username" }]) {
    await serve({}, async ({ call, bridge, label, of }) => {
      const l = await label();
      bridge.seals.set("7:0", seal);
      expect(await call("fill_field", { id: "mail", field: 0, value: l })).toEqual({ text: "Le champ n'est plus celui de ta lecture : rien n'a été écrit. Relis l'onglet avec read_tab.", isError: true });
      expect(of("askFill")).toEqual([]);
      expect(of("fill.commit")).toEqual([]);
    });
  }
});

test("a value of the user's sources filled on a page the agent reached, off the origins it was read on, carries a red line", async () => {
  await serve({}, async ({ call, label, of }) => {
    const l = await label();
    await call("read_tab", { id: "copie" });
    expect((await call("fill_field", { id: "copie", field: 0, value: l })).text).toBe("Champ rempli.");
    expect(of("askFill")[0]![0]).toMatchObject({ name: "votre code", touchId: true, danger: "Cette page, ouverte par l'agent, est sur copie.test : votre code a été lu sur mail.example-novacourriel.test." });
    // On the user's own tab (a page they reached), the same value goes with the plain card: copying a code where it is asked.
    expect((await call("fill_field", { id: "mail", field: 0, value: l })).text).toBe("Champ rempli.");
    expect(of("askFill")[1]![0]).not.toHaveProperty("danger");
  });
});

test("fill_field takes an issued label without its brackets", async () => {
  await serve({}, async ({ call, of }) => {
    const l = (await call("read_tab", { id: "mail" })).text.match(/⟨code-[a-z0-9]{8}⟩/)![0];
    expect(await call("fill_field", { id: "mail", field: 0, value: l.slice(1, -1) })).toEqual({ text: "Champ rempli.", isError: false });
    expect(of("fill.commit")[0]!.slice(1)).toEqual([{ text: CODE }, HOST]);
  });
});

// The passport (design § 8): an address on profile `perso`, fillable on boutique.example.
const P_MAIL = "https://mail.example";
const P_SHOP = "https://boutique.example";
const P_ELSE = "https://autre.example";
const P_FIELDS = [
  { handle: "5:0", type: "text", autocomplete: "", label: "Adresse" },
  { handle: "5:1", type: "date", autocomplete: "", label: "Né le" },
  { handle: "5:2", type: "text", autocomplete: "", label: "Date (JJ/MM/AAAA)" },
  { handle: "5:3", type: "password", autocomplete: "current-password", label: "Mot de passe" },
  { handle: "5:4", type: "text", autocomplete: "", label: "Prénom" },
  { handle: "5:5", type: "text", autocomplete: "", label: "Nom" },
  { handle: "5:6", type: "text", autocomplete: "", label: "Code postal" },
];
const ADDRESS = "14 rue des Tanneurs\n69005 Lyon";
const pEntry = (id: string, field: PassportField, value: PassportValue, extra: Partial<PassportEntry> = {}): PassportEntry => ({
  id: id.padStart(16, "0"), field, value, variants: [], origins: [], how: "typed", created: "2026-11-23T10:00:00.000Z", updated: "2026-11-23T10:00:00.000Z", ...extra,
});
const ADDRESS_ENTRY = pEntry("a1", "adresse", { text: ADDRESS }, { origins: ["boutique.example"] });
const NAISSANCE = pEntry("b2", "naissance", { text: "1990-03-14" });
const PROCHE = pEntry("c3", "proche", { given: "Julien", family: "Aubrac" });
const ptab = (id: string, url: string, agentReached = false, profile = "perso"): TabInfo => ({ id, title: id, url, space: "perso", profile, agentReached });

type PCtx = Ctx & { store: PassportStore; labelOf: (type: string) => Promise<string>; cards: () => Record<string, unknown>[]; another: (session: string, win: string) => Call };

async function servePassport(o: { tabs?: TabInfo[]; passports?: Record<string, PassportEntry[]>; text?: string; yes?: boolean; main?: boolean }, attempt: (x: PCtx) => Promise<void>) {
  const store = new PassportStore();
  for (const [profile, entries] of Object.entries(o.passports ?? { perso: [ADDRESS_ENTRY, NAISSANCE, PROCHE] })) store.replace(profile, entries);
  const tabs = o.tabs ?? [ptab("mail", `${P_MAIL}/inbox`), ptab("shop", `${P_SHOP}/commande`), ptab("autre", `${P_ELSE}/form`)];
  const bridge = new FakeBridge(tabs, { active: "mail", allow: true, address: true, reveal: true, fill: { yes: o.yes ?? true } });
  const text = o.text ?? `Livraison : 14 rue des Tanneurs, 69005 Lyon. Né le 14/03/1990. Mon frère Julien Aubrac.`;
  for (const t of tabs) bridge.pages.set(t.id, { text, links: [], fields: P_FIELDS });
  const masker = new Masker({ passport: store });
  const token = generateToken();
  const s = await startMcpServer({ bridge, policy: new AccessPolicy(), token, masker, locale: () => "fr" });
  masker.open("A", "W1");
  const session = o.main ? token : s.openSession("W1", undefined, "A");
  const clients: Client[] = [];
  const results: string[] = [];
  const callAs = (token: string): Call => async (name, args) => {
    const c = new Client({ name: "test", version: "0" });
    clients.push(c);
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${s.port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    const r = await c.callTool({ name, arguments: args });
    const text = (r.content as { text?: string }[]).map((x) => x.text ?? "").join("\n");
    results.push(text);
    return { text, isError: r.isError === true };
  };
  const call = callAs(session);
  /** A conversation started now, in another window. */
  const another = (id: string, w: string) => {
    masker.open(id, w);
    return callAs(s.openSession(w, undefined, id));
  };
  const labelOf = async (type: string) => (await call("read_tab", { id: "mail" })).text.match(new RegExp(`⟨${type}-[a-z0-9]{8}⟩`))![0];
  const of = (m: string) => bridge.calls.filter((c) => c.method === m).map((c) => c.args);
  const cards = () => of("askFill").map((a) => a[0] as Record<string, unknown>);
  try {
    await attempt({ call, bridge, masker, results, label: () => labelOf("adresse"), of, store, labelOf, cards, another });
  } finally {
    vi.useRealTimers();
    await Promise.all(clients.map((c) => c.close()));
    await s.stop();
  }
}

test("a passport label: the card alone on its origin, Touch ID elsewhere, once per origin for 5 minutes", async () => {
  await servePassport({}, async ({ call, labelOf, cards }) => {
    const l = await labelOf("adresse");
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-23T10:00:00Z") });
    await call("read_tab", { id: "shop" });
    expect((await call("fill_field", { id: "shop", field: 0, value: l })).text).toBe("Champ rempli.");
    expect(cards()[0]).toMatchObject({ touchId: false });
    await call("read_tab", { id: "autre" });
    await call("fill_field", { id: "autre", field: 0, value: l });
    expect(cards()[1]).toMatchObject({ touchId: true });
    vi.setSystemTime(new Date("2026-11-23T10:04:00Z"));
    await call("fill_field", { id: "autre", field: 0, value: l });
    expect(cards()[2]).toMatchObject({ touchId: false });
    // The window runs from the last Touch ID, not from the fills it spared.
    vi.setSystemTime(new Date("2026-11-23T10:05:01Z"));
    await call("fill_field", { id: "autre", field: 0, value: l });
    expect(cards()[3]).toMatchObject({ touchId: true });
  });
});

test("the Touch ID window opens only once a fill is written: a field that changed leaves it shut", async () => {
  await servePassport({}, async ({ call, bridge, labelOf, cards }) => {
    const l = await labelOf("adresse");
    await call("read_tab", { id: "autre" });
    bridge.fillAnswers.push("changed");
    expect((await call("fill_field", { id: "autre", field: 0, value: l })).isError).toBe(true);
    expect(cards()[0]).toMatchObject({ touchId: true });
    expect((await call("fill_field", { id: "autre", field: 0, value: l })).text).toBe("Champ rempli.");
    expect(cards()[1]).toMatchObject({ touchId: true });
    await call("fill_field", { id: "autre", field: 0, value: l });
    expect(cards()[2]).toMatchObject({ touchId: false });
  });
});

test("a site added before the conversation's first read counts in it: the conversation's sites are taken at its first read", async () => {
  await servePassport({}, async ({ call, store }) => {
    store.replace("perso", [{ ...ADDRESS_ENTRY, origins: ["boutique.example", "autre.example"] }, NAISSANCE, PROCHE]);
    expect((await call("read_tab", { id: "autre" })).text).not.toContain("Tanneurs");
  });
});

test("the conversation's sites are taken at its first tool call, zoned or not: a site added after it changes nothing", async () => {
  await servePassport({}, async ({ call, store }) => {
    // A first call that zones no page (read_pages, a search tab, a widget would do the same): it already showed something.
    expect((await call("read_tab", { id: "nulle-part" })).isError).toBe(true);
    store.replace("perso", [{ ...ADDRESS_ENTRY, origins: ["boutique.example", "autre.example"] }, NAISSANCE, PROCHE]);
    expect((await call("read_tab", { id: "autre" })).text).toContain("Tanneurs");
  });
});

test("a site added to an entry mid-conversation changes nothing in it: its pages stay web and its fill still asks Touch ID; a new conversation masks there", async () => {
  await servePassport({}, async ({ call, store, labelOf, cards, another }) => {
    const l = await labelOf("adresse");
    expect((await call("read_tab", { id: "autre" })).text).toContain("Tanneurs");
    store.replace("perso", [{ ...ADDRESS_ENTRY, origins: ["boutique.example", "autre.example"] }, NAISSANCE, PROCHE]);
    expect((await call("read_tab", { id: "autre" })).text).toContain("Tanneurs");
    await call("fill_field", { id: "autre", field: 0, value: l });
    expect(cards()[0]).toMatchObject({ touchId: true });
    expect((await another("B", "W2")("read_tab", { id: "autre" })).text).not.toContain("Tanneurs");
  });
});

test("a site removed from an entry mid-conversation stays a source in it; a new conversation reads it as the web", async () => {
  await servePassport({}, async ({ call, store, another }) => {
    expect((await call("read_tab", { id: "shop" })).text).not.toContain("Tanneurs");
    store.replace("perso", [{ ...ADDRESS_ENTRY, origins: [] }, NAISSANCE, PROCHE]);
    expect((await call("read_tab", { id: "shop" })).text).not.toContain("Tanneurs");
    expect((await another("B", "W2")("read_tab", { id: "shop" })).text).toContain("Tanneurs");
  });
});

test("a passport label read in the user's sources fills there with the card alone", async () => {
  await servePassport({}, async ({ call, labelOf, cards }) => {
    const l = await labelOf("adresse");
    await call("fill_field", { id: "mail", field: 0, value: l });
    expect(cards()[0]).toMatchObject({ touchId: false });
  });
});

test("a passport label on a tab of another profile: the card names its passport, Touch ID unchanged", async () => {
  await servePassport({ tabs: [ptab("mail", `${P_MAIL}/inbox`), ptab("shop", `${P_SHOP}/commande`, false, "travail")] }, async ({ call, labelOf, cards }) => {
    const l = await labelOf("adresse");
    await call("read_tab", { id: "shop" });
    await call("fill_field", { id: "shop", field: 0, value: l });
    expect(cards()[0]).toMatchObject({ passportProfile: "perso", touchId: false });
    await call("fill_field", { id: "mail", field: 0, value: l });
    expect(cards()[1]).not.toHaveProperty("passportProfile");
  });
});

test("a passport date goes as YYYY-MM-DD into a date field, DD/MM/YYYY into a text field; nothing of the passport into a password field", async () => {
  await servePassport({}, async ({ call, labelOf, of }) => {
    const d = await labelOf("date");
    expect((await call("fill_field", { id: "mail", field: 1, value: d })).text).toBe("Champ rempli.");
    expect((await call("fill_field", { id: "mail", field: 2, value: d })).text).toBe("Champ rempli.");
    expect(of("fill.commit").map((c) => c[1])).toEqual([{ text: "1990-03-14" }, { text: "14/03/1990" }]);
    expect(await call("fill_field", { id: "mail", field: 3, value: await labelOf("adresse") })).toEqual({ text: "Ce champ est un mot de passe : seuls un code ou un mot de passe y vont.", isError: true });
  });
});

test("after a fill, the value stays masked in later reads of the field's origin, and only there (design § 8.5)", async () => {
  await servePassport({ tabs: [ptab("mail", `${P_MAIL}/inbox`), ptab("shop", `${P_SHOP}/commande`, true), ptab("autre", `${P_ELSE}/form`, true)] }, async ({ call, labelOf }) => {
    const l = await labelOf("adresse");
    expect((await call("read_tab", { id: "shop" })).text).toContain("14 rue des Tanneurs, 69005 Lyon");
    await call("fill_field", { id: "shop", field: 0, value: l });
    const shop = (await call("read_tab", { id: "shop" })).text;
    expect(shop).not.toContain("Tanneurs");
    // A web label, never the sources' one (two zones).
    expect(shop).toMatch(/⟨adresse-[a-z0-9]{8}⟩/);
    expect(shop).not.toContain(l);
    expect((await call("read_tab", { id: "autre" })).text).toContain("14 rue des Tanneurs, 69005 Lyon");
  });
});

test("a filled e-mail stays masked in later reads of the field's origin, by its label or by kind, and only there (design § 8.5)", async () => {
  const email = "c" + "amille.au" + "brac@ex" + "ample.fr";
  const tabs = [ptab("mail", `${P_MAIL}/inbox`), ptab("shop", `${P_SHOP}/commande`, true), ptab("autre", `${P_ELSE}/form`, true), ptab("tiers", "https://tiers.example/form", true)];
  await servePassport({ tabs, passports: { perso: [pEntry("f6", "email", { text: email })] }, text: `Écrire à ${email}.` }, async ({ call, labelOf }) => {
    const l = await labelOf("email");
    expect((await call("read_tab", { id: "shop" })).text).toContain(email);
    expect((await call("fill_field", { id: "shop", field: 0, value: l })).text).toBe("Champ rempli.");
    // As in the sources, the local part is masked and the domain kept.
    expect((await call("read_tab", { id: "shop" })).text).toMatch(/⟨email-[a-z0-9]{8}⟩@example\.fr/);
    expect((await call("read_tab", { id: "autre" })).text).toContain(email);
    expect((await call("fill_field", { id: "autre", field: 0, passport: "email" })).text).toBe("Champ rempli.");
    expect((await call("read_tab", { id: "autre" })).text).not.toContain("amille");
    expect((await call("read_tab", { id: "tiers" })).text).toContain(email);
  });
});

test("Review Focus 5: an entry edited then removed after its label was issued fills the value shown, with Touch ID, and stays masked", async () => {
  await servePassport({}, async ({ call, store, labelOf, cards, of }) => {
    const l = await labelOf("adresse");
    store.replace("perso", [{ ...ADDRESS_ENTRY, value: { text: "3 place Bellecour\n69002 Lyon" } }, NAISSANCE, PROCHE]);
    store.replace("perso", [NAISSANCE, PROCHE]);
    await call("read_tab", { id: "shop" });
    expect((await call("fill_field", { id: "shop", field: 0, value: l })).text).toBe("Champ rempli.");
    expect(of("fill.commit")[0]![1]).toEqual({ text: ADDRESS });
    expect(cards()[0]).toMatchObject({ touchId: true });
    const again = (await call("read_tab", { id: "mail" })).text;
    expect(again).toContain(l);
    expect(again).not.toContain("Tanneurs");
    // The page the value went to: masked there too, although the passport no longer has it.
    expect((await call("read_tab", { id: "shop" })).text).not.toContain("Tanneurs");
  });
});

test("the card names the passport field; the agent only ever reads the type's name", async () => {
  await servePassport({}, async ({ call, labelOf, cards, results }) => {
    const a = await labelOf("adresse");
    await call("fill_field", { id: "mail", field: 0, value: a });
    expect(cards()[0]).toMatchObject({ name: "votre adresse" });
    const p = (await call("read_tab", { id: "mail" })).text.match(/⟨nom-[a-z0-9]{8}⟩/)![0];
    await call("fill_field", { id: "mail", field: 0, value: p });
    expect(cards()[1]).toMatchObject({ name: "le nom d'un proche" });
    expect(results.join("\n")).not.toMatch(/proche/i);
  });
});

test("an open Touch ID window never spares a tab the agent reached (ruling F16)", async () => {
  await servePassport({ tabs: [ptab("mail", `${P_MAIL}/inbox`), ptab("autre", `${P_ELSE}/form`), ptab("autre2", `${P_ELSE}/suite`, true)] }, async ({ call, labelOf, cards }) => {
    const l = await labelOf("adresse");
    await call("read_tab", { id: "autre" });
    // A user tab off the value's origins: Touch ID, answered yes, opens the window on autre.example.
    await call("fill_field", { id: "autre", field: 0, value: l });
    expect(cards()[0]).toMatchObject({ touchId: true });
    // The window is open: the same user tab is spared.
    await call("fill_field", { id: "autre", field: 0, value: l });
    expect(cards()[1]).toMatchObject({ touchId: false });
    // Inside that window, a tab the agent reached on the same origin still asks.
    await call("read_tab", { id: "autre2" });
    await call("fill_field", { id: "autre2", field: 0, value: l });
    expect(cards()[2]).toMatchObject({ touchId: true });
  });
});

test("the foreign red line counts a passport value's declared origins: none on its own site, one elsewhere", async () => {
  await servePassport({ tabs: [ptab("mail", `${P_MAIL}/inbox`), ptab("shop", `${P_SHOP}/commande`, true), ptab("autre", `${P_ELSE}/form`, true)] }, async ({ call, labelOf, cards }) => {
    const l = await labelOf("adresse");
    await call("read_tab", { id: "shop" });
    await call("fill_field", { id: "shop", field: 0, value: l });
    expect(cards()[0]).not.toHaveProperty("danger");
    await call("read_tab", { id: "autre" });
    await call("fill_field", { id: "autre", field: 0, value: l });
    expect(String(cards()[1]!.danger)).toContain("boutique.example");
  });
});

// Fill by kind (design § 8.3) and several fields on one card (§ 8.4).
const DENIED = { text: "L'utilisateur a refusé ce remplissage : rien n'a été écrit.", isError: false };
const NAME_ENTRY = pEntry("d4", "nom", { given: "Camille", family: "Aubrac" });
const ADDRESS_ENTRY_2 = pEntry("e5", "adresse", { text: "3 place Bellecour\n69002 Lyon" });
type Row = { field: string; name: string; choices?: { ref: string; shown: string; value: string }[] };
const rowsOf = (card: Record<string, unknown> | undefined) => card?.rows as Row[];

test("passport: one entry of that kind in the tab's passport: one row, one choice taken, the field holds its value; the agent gets FILLED", async () => {
  await servePassport({}, async ({ call, cards, of, results }) => {
    await call("read_tab", { id: "shop" });
    expect(await call("fill_field", { id: "shop", field: 0, passport: "adresse" })).toEqual({ text: "Champ rempli.", isError: false });
    expect(cards()).toHaveLength(1);
    // The tab's profile, for the card's « Ouvrir le passeport ».
    expect(cards()[0]).toMatchObject({ name: "votre adresse", field: "Adresse", touchId: false, labels: [], profile: "perso" });
    expect(rowsOf(cards()[0])).toEqual([{ field: "Adresse", name: "votre adresse", kind: "adresse", choices: [{ ref: expect.any(String), shown: maskedDisplay(ADDRESS_ENTRY), value: ADDRESS }] }]);
    expect(of("fill.commit").map((c) => c.slice(1))).toEqual([[{ text: ADDRESS }, P_SHOP]]);
    expect(results.join("\n")).not.toContain("Tanneurs");
  });
});

test("passport: two entries of that kind give two choices; the pick decides the value", async () => {
  await servePassport({ passports: { perso: [ADDRESS_ENTRY, ADDRESS_ENTRY_2] } }, async ({ call, bridge, cards, of }) => {
    const ask = bridge.askFill!;
    bridge.askFill = async (d, w, s) => {
      await ask(d, w, s);
      return { yes: true, picks: [d.rows![0]!.choices![1]!.ref] };
    };
    await call("read_tab", { id: "shop" });
    expect((await call("fill_field", { id: "shop", field: 0, passport: "adresse" })).text).toBe("Champ rempli.");
    expect(rowsOf(cards()[0])[0]!.choices!.map((c) => c.value)).toEqual([ADDRESS, "3 place Bellecour\n69002 Lyon"]);
    expect(of("fill.commit")[0]![1]).toEqual({ text: "3 place Bellecour\n69002 Lyon" });
  });
});

test("passport: two choices and no pick fill nothing; the agent reads the refusal", async () => {
  await servePassport({ passports: { perso: [ADDRESS_ENTRY, ADDRESS_ENTRY_2] } }, async ({ call, of }) => {
    await call("read_tab", { id: "shop" });
    expect(await call("fill_field", { id: "shop", field: 0, passport: "adresse" })).toEqual(DENIED);
    expect(of("fill.commit")).toEqual([]);
  });
});

test("passport: nothing of that kind in the tab's passport (another profile has one): a card with no choice, the same answer as a refused card (no oracle)", async () => {
  let refused: unknown;
  await servePassport({ yes: false }, async ({ call }) => {
    await call("read_tab", { id: "shop" });
    refused = await call("fill_field", { id: "shop", field: 0, passport: "adresse" });
  });
  expect(refused).toEqual(DENIED);
  await servePassport({ passports: { perso: [NAISSANCE], travail: [ADDRESS_ENTRY] } }, async ({ call, cards, of }) => {
    await call("read_tab", { id: "shop" });
    expect(await call("fill_field", { id: "shop", field: 0, passport: "adresse" })).toEqual(refused);
    expect(rowsOf(cards()[0])).toEqual([{ field: "Adresse", name: "votre adresse", kind: "adresse", choices: [] }]);
    expect(of("fill.commit")).toEqual([]);
  });
});

test("passport: a tab of the agent's own profile, a site app's or with no profile proposes nothing", async () => {
  const tabs = [ptab("mail", `${P_MAIL}/inbox`), ptab("a", `${P_SHOP}/a`, false, "agent"), ptab("s", `${P_SHOP}/s`, false, "site-abc"), { ...ptab("n", `${P_SHOP}/n`), profile: undefined }];
  await servePassport({ tabs, passports: { perso: [ADDRESS_ENTRY], agent: [ADDRESS_ENTRY], "site-abc": [ADDRESS_ENTRY] } }, async ({ call, cards, of }) => {
    for (const id of ["a", "s", "n"]) {
      await call("read_tab", { id });
      expect(await call("fill_field", { id, field: 0, passport: "adresse" })).toEqual(DENIED);
    }
    expect(cards().map((c) => rowsOf(c)[0]!.choices)).toEqual([[], [], []]);
    // No passport of their own: no profile to open.
    expect(cards().map((c) => c.profile)).toEqual([undefined, undefined, undefined]);
    expect(of("fill.commit")).toEqual([]);
  });
});

test("passport: a date by kind goes as the field takes it; nothing into a password field", async () => {
  await servePassport({}, async ({ call, of }) => {
    await call("read_tab", { id: "mail" });
    await call("fill_field", { id: "mail", field: 1, passport: "naissance" });
    await call("fill_field", { id: "mail", field: 2, passport: "naissance" });
    expect(of("fill.commit").map((c) => c[1])).toEqual([{ text: "1990-03-14" }, { text: "14/03/1990" }]);
    expect(await call("fill_field", { id: "mail", field: 3, passport: "adresse" })).toEqual({ text: "Ce champ est un mot de passe : seuls un code ou un mot de passe y vont.", isError: true });
  });
});

test("passport: off the entry's origins, Touch ID, and the window opened then spares the next kind fill there", async () => {
  await servePassport({}, async ({ call, cards }) => {
    await call("read_tab", { id: "autre" });
    await call("fill_field", { id: "autre", field: 0, passport: "adresse" });
    await call("fill_field", { id: "autre", field: 0, passport: "adresse" });
    expect(cards().map((c) => c.touchId)).toEqual([true, false]);
  });
});

test("value, saved_login and passport exclude each other", async () => {
  await servePassport({}, async ({ call, of }) => {
    await call("read_tab", { id: "mail" });
    const both = { text: "Donne soit `value`, soit `saved_login`, soit `passport`.", isError: true };
    expect(await call("fill_field", { id: "mail", field: 0, value: "x", passport: "adresse" })).toEqual(both);
    expect(await call("fill_field", { id: "mail", field: 0, saved_login: true, passport: "adresse" })).toEqual(both);
    expect(await call("fill_field", { id: "mail", field: 0 })).toEqual(both);
    expect((await call("fill_field", { id: "mail", field: 0, passport: "adresse", also: [{ field: 4 }] })).isError).toBe(true);
    expect((await call("fill_field", { id: "mail", field: 0, passport: "rien" })).isError).toBe(true);
    expect(of("fill.prepare")).toEqual([]);
  });
});

test("also: four fields on one card with one Touch ID, written in order; a row whose seal changed is told by its number", async () => {
  await servePassport({ passports: { perso: [ADDRESS_ENTRY, NAME_ENTRY] } }, async ({ call, bridge, cards, of }) => {
    await call("read_tab", { id: "autre" });
    bridge.fillAnswers = ["filled", "filled", "changed", "filled"];
    const r = await call("fill_field", { id: "autre", field: 0, passport: "adresse_voie", also: [{ field: 4, passport: "prenoms" }, { field: 5, passport: "nom_famille" }, { field: 6, passport: "code_postal" }] });
    expect(r).toEqual({ text: "Rempli : 0, 1, 3. Pas rempli (le champ a changé) : 2.", isError: false });
    expect(cards()).toHaveLength(1);
    expect(cards()[0]).toMatchObject({ touchId: true, field: "Adresse, Prénom, Nom, Code postal" });
    expect(rowsOf(cards()[0]).map((x) => [x.field, x.name, x.choices!.map((c) => c.value)])).toEqual([
      ["Adresse", "votre rue", ["14 rue des Tanneurs"]],
      ["Prénom", "votre prénom", ["Camille"]],
      ["Nom", "votre nom de famille", ["Aubrac"]],
      ["Code postal", "votre code postal", ["69005"]],
    ]);
    expect(of("fill.prepare").map((c) => c[1])).toEqual(["5:0", "5:4", "5:5", "5:6"]);
    expect(of("fill.commit").map((c) => c[1])).toEqual([{ text: "14 rue des Tanneurs" }, { text: "Camille" }, { text: "Aubrac" }, { text: "69005" }]);
  });
});

test("also: a refused card writes nothing; a row's own rules refuse the whole call before any card", async () => {
  await servePassport({ yes: false }, async ({ call, of, labelOf }) => {
    const l = await labelOf("adresse");
    await call("read_tab", { id: "shop" });
    expect(await call("fill_field", { id: "shop", field: 0, value: l, also: [{ field: 4, passport: "prenoms" }] })).toEqual(DENIED);
    expect(of("askFill")).toHaveLength(1);
    expect(await call("fill_field", { id: "shop", field: 0, value: l, also: [{ field: 3, passport: "adresse" }] })).toEqual({ text: "Ce champ est un mot de passe : seuls un code ou un mot de passe y vont.", isError: true });
    expect(of("askFill")).toHaveLength(1);
    expect(of("fill.commit")).toEqual([]);
  });
});

test("also: 12 rows are refused by the schema, nothing prepared", async () => {
  await servePassport({}, async ({ call, of }) => {
    await call("read_tab", { id: "shop" });
    const r = await call("fill_field", { id: "shop", field: 0, passport: "adresse", also: Array.from({ length: 12 }, () => ({ field: 4, passport: "prenoms" })) });
    expect(r.isError).toBe(true);
    expect(of("fill.prepare")).toEqual([]);
    expect((await call("fill_field", { id: "shop", field: 0, passport: "adresse", also: Array.from({ length: 11 }, () => ({ field: 4, value: "x" })) })).text).toMatch(/^Rempli : 0, 1,/);
  });
});

test("ruling F3: a value filled by kind stays masked in later reads of that origin, and only there", async () => {
  await servePassport({ tabs: [ptab("mail", `${P_MAIL}/inbox`), ptab("shop", `${P_SHOP}/commande`, true), ptab("autre", `${P_ELSE}/form`, true)] }, async ({ call }) => {
    expect((await call("read_tab", { id: "shop" })).text).toContain("14 rue des Tanneurs, 69005 Lyon");
    await call("fill_field", { id: "shop", field: 0, passport: "adresse" });
    const shop = (await call("read_tab", { id: "shop" })).text;
    expect(shop).not.toContain("Tanneurs");
    expect(shop).toMatch(/⟨adresse-[a-z0-9]{8}⟩/);
    expect((await call("read_tab", { id: "autre" })).text).toContain("14 rue des Tanneurs, 69005 Lyon");
  });
});

test("ruling F3 through the main token: a value it filled by kind stays masked in its later reads of that origin, and only there", async () => {
  await servePassport({ main: true, tabs: [ptab("mail", `${P_MAIL}/inbox`), ptab("shop", `${P_SHOP}/commande`, true), ptab("autre", `${P_ELSE}/form`, true)] }, async ({ call }) => {
    expect((await call("read_tab", { id: "shop" })).text).toContain("14 rue des Tanneurs, 69005 Lyon");
    expect((await call("fill_field", { id: "shop", field: 0, passport: "adresse" })).text).toBe("Champ rempli.");
    const shop = (await call("read_tab", { id: "shop" })).text;
    expect(shop).not.toContain("Tanneurs");
    expect(shop).toMatch(/⟨adresse-[a-z0-9]{8}⟩/);
    expect((await call("read_tab", { id: "autre" })).text).toContain("14 rue des Tanneurs, 69005 Lyon");
  });
});

test("ruling F3: also rows, by kind and by label, stay masked on the origin they were filled on", async () => {
  const text = "Livraison : 14 rue des Tanneurs, 69005 Lyon. Signé Camille Aubrac.";
  await servePassport({ text, passports: { perso: [ADDRESS_ENTRY, NAME_ENTRY] }, tabs: [ptab("mail", `${P_MAIL}/inbox`), ptab("autre", `${P_ELSE}/form`, true)] }, async ({ call, labelOf }) => {
    const l = await labelOf("adresse");
    expect((await call("read_tab", { id: "autre" })).text).toContain("Camille Aubrac");
    expect((await call("fill_field", { id: "autre", field: 5, value: "Bonjour", also: [{ field: 0, value: l }, { field: 4, passport: "nom_complet" }] })).text).toBe("Rempli : 0, 1, 2.");
    const autre = (await call("read_tab", { id: "autre" })).text;
    expect(autre).not.toContain("Tanneurs");
    expect(autre).not.toContain("Camille");
    expect(autre).not.toContain(l);
  });
});

test("review: a filled part of an entry stays masked on its own on that origin, and only there (design § 8.5)", async () => {
  const text = "Merci Camille ! Livraison au 14 rue des Tanneurs, code postal 69005, à Lyon. Nom : AUBRAC.";
  await servePassport({ text, passports: { perso: [ADDRESS_ENTRY, NAME_ENTRY] }, tabs: [ptab("mail", `${P_MAIL}/inbox`), ptab("shop", `${P_SHOP}/commande`, true), ptab("autre", `${P_ELSE}/form`, true)] }, async ({ call }) => {
    await call("read_tab", { id: "shop" });
    expect((await call("fill_field", { id: "shop", field: 6, passport: "code_postal", also: [{ field: 5, passport: "nom_famille" }] })).text).toBe("Rempli : 0, 1.");
    const shop = (await call("read_tab", { id: "shop" })).text;
    expect(shop).not.toContain("69005");
    expect(shop).not.toContain("AUBRAC");
    const autre = (await call("read_tab", { id: "autre" })).text;
    expect(autre).toContain("code postal 69005");
    expect(autre).toContain("Nom : AUBRAC");
  });
});

test("review: the main token never opens nor uses the 5-minute Touch ID window (it belongs to no conversation)", async () => {
  await servePassport({ main: true }, async ({ call, cards }) => {
    await call("read_tab", { id: "autre" });
    expect((await call("fill_field", { id: "autre", field: 0, passport: "adresse" })).text).toBe("Champ rempli.");
    await call("fill_field", { id: "autre", field: 0, passport: "adresse" });
    expect(cards().map((c) => c.touchId)).toEqual([true, true]);
  });
});

test("review: an also card with a kind the passport lacks beside a label row answers as a refusal, byte for byte, and writes nothing", async () => {
  let refused: unknown;
  await servePassport({ yes: false }, async ({ call, labelOf }) => {
    const l = await labelOf("adresse");
    await call("read_tab", { id: "shop" });
    refused = await call("fill_field", { id: "shop", field: 0, value: l, also: [{ field: 4, passport: "iban" }] });
  });
  expect(refused).toEqual(DENIED);
  await servePassport({}, async ({ call, labelOf, cards, of }) => {
    const l = await labelOf("adresse");
    await call("read_tab", { id: "shop" });
    expect(await call("fill_field", { id: "shop", field: 0, value: l, also: [{ field: 4, passport: "iban" }] })).toEqual(refused);
    expect(rowsOf(cards()[0])[1]).toEqual({ field: "Prénom", name: "votre IBAN", kind: "iban", choices: [] });
    expect(of("fill.commit")).toEqual([]);
  });
});

test("review 2: a filled part or whole entry matches only between word boundaries, never inside another word or number", async () => {
  const text = "Ville : Lyon, LYON, Lyonnais, Ablyon. CP 69005, 690051, 1690052. Né le 14/03/1990, 14/03/19901. Ancien : 14 rue des tanneurs 69005 lyonnais.";
  await servePassport({ text, passports: { perso: [ADDRESS_ENTRY, NAISSANCE] }, tabs: [ptab("mail", `${P_MAIL}/inbox`), ptab("shop", `${P_SHOP}/commande`, true)] }, async ({ call }) => {
    await call("read_tab", { id: "shop" });
    const r = await call("fill_field", { id: "shop", field: 4, passport: "ville", also: [{ field: 6, passport: "code_postal" }, { field: 2, passport: "naissance" }, { field: 0, passport: "adresse" }] });
    expect(r.text).toBe("Rempli : 0, 1, 2, 3.");
    const shop = (await call("read_tab", { id: "shop" })).text;
    const L = "⟨adresse-[a-z0-9]{8}⟩";
    expect(shop).toMatch(new RegExp(`Ville : ${L}, ${L}, Lyonnais, Ablyon\\. CP ${L}, 690051, 1690052\\.`));
    expect(shop).toMatch(/Né le ⟨date-[a-z0-9]{8}⟩, 14\/03\/19901\./);
    expect(shop).toContain("lyonnais.");
  });
});

test("review 2: a part under 4 folded characters is not masked at all, and never cut out of another word", async () => {
  const PAU = pEntry("f6", "adresse", { text: "2 rue Henri IV\n64000 Pau" });
  await servePassport({ text: "Ville : Pau. Sur l'épaule.", passports: { perso: [PAU] }, tabs: [ptab("mail", `${P_MAIL}/inbox`), ptab("shop", `${P_SHOP}/commande`, true)] }, async ({ call, of }) => {
    await call("read_tab", { id: "shop" });
    expect((await call("fill_field", { id: "shop", field: 4, passport: "ville" })).text).toBe("Champ rempli.");
    expect(of("fill.commit")[0]![1]).toEqual({ text: "Pau" });
    expect((await call("read_tab", { id: "shop" })).text).toContain("Ville : Pau. Sur l'épaule.");
  });
});

// « Retenir ce site » (task 13b): the card names which rows may remember the field's site in their passport entry; the
// agent never learns of it (the kernel's answer has no such field).
const refOf = (e: PassportEntry) => ({ profile: "perso", id: e.id });
const rememberOf = (card: Record<string, unknown> | undefined) => card?.remember as { row: number; choice?: string; seal: string; profile: string; id: string }[] | undefined;

test("remember: offered off the entry's hosts on a tab the user reached; not on its host, an agent-reached tab, another profile's tab, nor at 20 hosts", async () => {
  const tabs = [ptab("mail", `${P_MAIL}/inbox`), ptab("shop", `${P_SHOP}/commande`), ptab("autre", `${P_ELSE}/form`), ptab("piege", "https://piege.example/form", true), ptab("travail", "https://travail.example/form", false, "travail")];
  await servePassport({ tabs }, async ({ call, labelOf, cards, of }) => {
    const l = await labelOf("adresse");
    for (const id of ["autre", "shop", "piege", "travail"]) {
      await call("read_tab", { id });
      expect((await call("fill_field", { id, field: 0, value: l })).text).toBe("Champ rempli.");
    }
    const seals = of("fill.commit").map((c) => c[0]);
    expect(rememberOf(cards()[0])).toEqual([{ row: 0, seal: seals[0], ...refOf(ADDRESS_ENTRY) }]);
    expect(cards().slice(1).map(rememberOf)).toEqual([undefined, undefined, undefined]);
  });
  const full = { ...ADDRESS_ENTRY, origins: Array.from({ length: 20 }, (_, i) => `s${i}.example`) };
  await servePassport({ passports: { perso: [full] } }, async ({ call, cards }) => {
    await call("read_tab", { id: "autre" });
    await call("fill_field", { id: "autre", field: 0, passport: "adresse" });
    expect(rememberOf(cards()[0])).toBeUndefined();
  });
});

test("remember: a kind row names each rememberable choice; with `also` each row has its own", async () => {
  await servePassport({ passports: { perso: [ADDRESS_ENTRY, ADDRESS_ENTRY_2, NAME_ENTRY] } }, async ({ call, cards }) => {
    await call("read_tab", { id: "autre" });
    await call("fill_field", { id: "autre", field: 0, passport: "adresse", also: [{ field: 4, passport: "prenoms" }] });
    const rows = rowsOf(cards()[0]);
    const remember = rememberOf(cards()[0])!;
    expect(remember.map((r) => [r.row, r.choice, r.id])).toEqual([
      [0, rows[0]!.choices![0]!.ref, ADDRESS_ENTRY.id],
      [0, rows[0]!.choices![1]!.ref, ADDRESS_ENTRY_2.id],
      [1, rows[1]!.choices![0]!.ref, NAME_ENTRY.id],
    ]);
    expect(new Set(remember.map((r) => r.seal)).size).toBe(2);
  });
});
