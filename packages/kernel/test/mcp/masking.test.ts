import { expect, test, vi } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AccessPolicy, DEV_RIGHTS } from "../../src/access/policy.js";
import type { TabInfo } from "../../src/mcp/bridge.js";
import { FakeBridge } from "../../src/mcp/fake-bridge.js";
import { createToolsServer, generateToken, sourceZone, startMcpServer } from "../../src/mcp/server.js";
import { Masker } from "../../src/mask/masker.js";
import { PassportStore } from "../../src/mask/passport.js";
import { SearchSessions } from "../../src/search/sessions.js";
import { BrowsingNotes } from "../../src/search/notes.js";
import { createRecaps } from "../../src/recaps/recaps.js";
import { Outflow } from "../../src/outflow/outflow.js";
import { tempFolder } from "../helpers/temp.js";
import { CODE, IBAN, PHONE, windows } from "../mask/values.js";

const MAIL = "camille.exemple" + "@" + "novacourriel.test";
const HOST = "https://mail.example-novacourriel.test";
const PROFILE_URL = `${HOST}/u/${MAIL}`;
const PAGE = `Camille Exemple\nTél : ${PHONE}\nÉcris à ${MAIL}\nIBAN : ${IBAN}\nTon code : ${CODE}`;
/** Only the IBAN: a phone in clear on a web page would share 4-digit windows with it. */
const IBAN_PAGE = `Relevé de Camille Exemple\nIBAN : ${IBAN}`;
const LABEL = /⟨[a-z]+-[a-z0-9]{8}⟩/g;
const labelOf = (type: string, t: string) => t.match(new RegExp(`⟨${type}-[a-z0-9]{8}⟩`))?.[0];

/** The user's webmail tab (reached by them, sensitive by its `mail.` host) and the same page in a tab the agent reached. */
const user: TabInfo = { id: "mail", title: "Boîte de réception", url: `${HOST}/inbox`, space: "perso", agentReached: false };
const copy: TabInfo = { id: "copie", title: "Boîte de réception", url: `${HOST}/inbox`, space: "perso", agentReached: true };


type Call = (name: string, args: Record<string, unknown>, token?: string) => Promise<{ text: string; isError: boolean }>;

async function serve(o: Partial<Parameters<typeof startMcpServer>[0]> & { bridge: FakeBridge }, attempt: (x: { call: Call; token: string; s: Awaited<ReturnType<typeof startMcpServer>>; masker: Masker; client: (t?: string) => Promise<Client> }) => Promise<void>) {
  const token = generateToken();
  const masker = o.masker ?? new Masker();
  const s = await startMcpServer({ locale: () => "fr", policy: new AccessPolicy(), token, ...o, masker });
  const clients: Client[] = [];
  const client = async (t = token) => {
    const c = new Client({ name: "test", version: "0" });
    clients.push(c);
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${s.port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${t}` } } }));
    return c;
  };
  const call: Call = async (name, args, t) => {
    const r = await (await client(t)).callTool({ name, arguments: args });
    return { text: (r.content as { text?: string }[]).map((c) => c.text ?? "").join("\n"), isError: r.isError === true };
  };
  try {
    await attempt({ call, token, s, masker, client });
  } finally {
    await Promise.all(clients.map((c) => c.close()));
    await s.stop();
  }
}

const bridgeWith = (pages: Record<string, { text: string; links?: { text: string; url: string }[] }>, o: Partial<ConstructorParameters<typeof FakeBridge>[1]> = {}, tabs = [user, copy]) => {
  const b = new FakeBridge(tabs, { active: "mail", allow: true, address: true, labelAlert: true, ...o });
  for (const [id, p] of Object.entries(pages)) b.pages.set(id, p);
  return b;
};

/** An option object whose every method fails with a message holding the IBAN. */
const failing = <T extends object>() =>
  new Proxy({} as T, {
    get: () => async () => {
      throw new Error("panne " + IBAN);
    },
  });

/** Minimal arguments for a JSON schema: the tab id where an id is asked, the first value of an enum. */
function sample(schema: Record<string, unknown>): unknown {
  if (Array.isArray(schema.enum)) return schema.enum[0];
  switch (schema.type) {
    case "string":
      return "mail";
    case "number":
    case "integer":
      return Math.max(0, Number(schema.minimum ?? 0));
    case "boolean":
      return true;
    case "array":
      return [sample((schema.items ?? {}) as Record<string, unknown>)];
    case "object": {
      const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
      return Object.fromEntries(((schema.required ?? []) as string[]).map((k) => [k, sample(props[k]!)]));
    }
    default:
      return {};
  }
}

const OVERRIDES: Record<string, Record<string, unknown>> = {
  navigate: { id: "copie", url: "https://exemple.fr/a" },
  open_tab: { url: "https://exemple.fr/b" },
  read_pages: { urls: [`${HOST}/inbox`] },
  search_web: { query: "banque", goal: "trouver" },
  read_history: { url: `${HOST}/inbox` },
  hand_over: { id: "mail", reason: "r", kind: "lost" },
  show_recap: { title: "Récap", results: [], plan: { blocks: [] } },
};

test("sourceZone: a site app window is the user's until the agent navigates it, in this conversation or as Firefox reports", () => {
  const site: TabInfo = { id: "site:mail", title: "Mail", url: `${HOST}/inbox`, space: "", site: "mail" };
  expect(sourceZone(site)).toBe("sources");
  expect(sourceZone(site, true)).toBe("web");
  expect(sourceZone({ ...site, agentReached: true })).toBe("web");
  expect(sourceZone({ ...site, agentReached: false })).toBe("sources");
});

test("invariant 1: every registered tool is behind the masker, and no result of any of them holds the IBAN", async () => {
  const folder = await tempFolder();
  const notesFile = join(folder, "carnet.md");
  await writeFile(notesFile, `# Carnet\n\n- IBAN noté ${IBAN}\n`);
  const history = { results: [{ url: `${HOST}/inbox`, title: `Relevé ${IBAN}`, lastVisit: "2026-11-20T10:00:00.000Z", visits: 2, excerpt: `IBAN ${IBAN}` }], texts: [{ url: `${HOST}/inbox`, title: "Relevé", date: "2026-11-20", text: IBAN_PAGE }] };
  // The user's own webmail: its URL, text and links hold their e-mail and phone (sources: all masked).
  const source: TabInfo = { ...user, url: `${HOST}/inbox?compte=${MAIL}` };
  const sourcePage = { text: `${IBAN_PAGE}\nÉcris à ${MAIL}, tél ${PHONE}`, links: [{ text: `IBAN ${IBAN}`, url: `${HOST}/r/${IBAN}` }, { text: `Profil ${MAIL}`, url: PROFILE_URL }] };
  const bridge = bridgeWith({ mail: sourcePage, copie: { text: IBAN_PAGE } }, { devTools: true, grantDev: [...DEV_RIGHTS], history, bookmarks: [{ title: `IBAN ${IBAN}`, url: `${HOST}/b` }], widgetData: true, search: {} }, [source, copy]);
  bridge.setConsole("mail", [{ timestamp: 1, level: "error", text: `IBAN ${IBAN}` }]);
  await serve(
    {
      bridge,
      apps: failing(),
      widgets: failing(),
      actions: failing(),
      sites: failing(),
      extensions: failing(),
      recaps: createRecaps({ folder }),
      search: new SearchSessions({ show: () => {} }),
      notes: new BrowsingNotes(notesFile, async () => "# Carnet\n\n"),
      openWorkflow: () => ({ widget: "w", block: null }),
      outflow: new Outflow(),
      agent: "Claude",
      settleMs: 0,
      emptySpanMs: 0,
      readPageMs: 2000,
    },
    async ({ call, masker, client }) => {
      const tools = (await (await client()).listTools()).tools;
      const names = tools.map((t) => t.name);
      // No tool is exempt from the masker (spec § 9 bis, invariant 1).
      expect([...names].sort()).toEqual([...masker.covered].sort());
      // Every option is on: the list covers the history, the dev tools, the search and the extensions.
      expect(names).toEqual(expect.arrayContaining(["search_history", "search_bookmarks", "read_console", "search_web", "note_lesson", "list_extensions", "site_memory", "show_recap", "launch_app", "harvest_widget", "launch_action", "open_workflow"]));
      const leaks: string[] = [];
      let read = 0;
      let shownTab = 0;
      for (const t of tools) {
        const r = await call(t.name, { ...(sample(t.inputSchema as Record<string, unknown>) as object), ...OVERRIDES[t.name] });
        if (r.text.includes("Relevé") || r.text.includes("IBAN") || r.text.includes("panne")) read++;
        const held = [...windows(IBAN), "camille.exemple", PHONE].filter((w) => r.text.includes(w));
        if (held.length) leaks.push(`${t.name}: ${held.join(",")}`);
        if (r.text.includes(`${HOST}/`)) shownTab++;
      }
      expect(leaks).toEqual([]);
      // Not a vacuous pass: many tools did read the IBAN's page, history, notebook or a failing option.
      expect(read).toBeGreaterThan(20);
      // …and several printed the source tab, its URL or its links.
      expect(shownTab).toBeGreaterThan(3);
    },
  );
}, 60_000);

test("an exception thrown by a handler, or by hand_over, comes back as a masked error", async () => {
  const bridge = bridgeWith({}, { search: {} });
  await serve({ bridge, widgets: failing(), search: new SearchSessions({ show: () => {} }), settleMs: 0, emptySpanMs: 0 }, async ({ call }) => {
    const harvest = await call("harvest_widget", { id: "w" });
    expect(harvest.isError).toBe(true);
    expect(harvest.text).toMatch(/^Erreur : panne ⟨iban-[a-z0-9]{8}⟩$/);
    await call("search_web", { query: "banque", goal: "trouver" });
    bridge.listTabs = () => Promise.reject(new Error("liste perdue " + IBAN));
    const hand = await call("hand_over", { id: "search-1", reason: "r", kind: "lost" });
    expect(hand.isError).toBe(true);
    expect(hand.text).toMatch(/^Erreur : liste perdue ⟨iban-[a-z0-9]{8}⟩$/);
  });
});

test("a tool with an outputSchema cannot be registered: the masker covers content only", () => {
  const server = createToolsServer(new FakeBridge([], { active: null, allow: false }), new AccessPolicy(), new Map());
  expect(() => server.registerTool("x", { outputSchema: {} }, async () => ({ content: [], structuredContent: {} }))).toThrow("outputSchema not supported: the masker covers content only");
});

test("the same page: masked as a source in the user's tab, high-risk only in the agent's, with different labels", async () => {
  await serve({ bridge: bridgeWith({ mail: { text: PAGE }, copie: { text: PAGE } }) }, async ({ call }) => {
    const mine = (await call("read_tab", { id: "mail" })).text;
    expect(mine).toMatch(/Tél : ⟨tel-[a-z0-9]{8}⟩/);
    expect(mine).toMatch(/Écris à ⟨email-[a-z0-9]{8}⟩@novacourriel\.test/);
    expect(mine).not.toContain(PHONE);
    expect(mine).not.toContain(MAIL);
    const agents = (await call("read_tab", { id: "copie" })).text;
    expect(agents).toContain(`Tél : ${PHONE}`);
    expect(agents).toContain(MAIL);
    expect(agents).not.toContain(IBAN);
    expect(labelOf("iban", agents)).toBeDefined();
    expect(labelOf("iban", agents)).not.toBe(labelOf("iban", mine));
  });
});

test("invariant 8: a session's labels resolve only in its own table; the main token's resolve nowhere; closing wipes", async () => {
  await serve({ bridge: bridgeWith({ mail: { text: PAGE } }) }, async ({ call, s, masker }) => {
    masker.open("A", "W1");
    masker.open("B", "W2");
    const a = (await call("read_tab", { id: "mail" }, s.openSession("W1", undefined, "A"))).text;
    const fromA = a.match(LABEL)!;
    expect(fromA.length).toBeGreaterThanOrEqual(4);
    const tableA = masker.table("A");
    for (const l of fromA) {
      expect(tableA.resolve(l)).toBeDefined();
      expect(masker.table("B").resolve(l)).toBeUndefined();
    }
    const main = (await call("read_tab", { id: "mail" })).text.match(LABEL)!;
    expect(main.length).toBeGreaterThanOrEqual(4);
    for (const l of main) expect(masker.table(null).resolve(l)).toBeUndefined();
    // A new conversation draws new labels for the main token too: nothing ties two conversations through it.
    masker.open("C", "W3");
    const again = (await call("read_tab", { id: "mail" })).text.match(LABEL)!;
    expect(again.filter((l) => main.includes(l))).toEqual([]);
    masker.close("A");
    for (const l of fromA) expect(tableA.resolve(l)).toBeUndefined();
    expect(tableA.entries("sources")).toEqual([]);
    expect(masker.sessionOf("W1")).toBeNull();
  });
});

test("Review Focus 4: a composed address holding an issued label is echoed with the label byte-identical", async () => {
  await serve({ bridge: bridgeWith({ mail: { text: PAGE } }) }, async ({ call, s, masker }) => {
    masker.open("A", "W1");
    const t = s.openSession("W1", undefined, "A");
    const label = labelOf("email", (await call("read_tab", { id: "mail" }, t)).text)!;
    const url = `https://exemple.fr/?to=${label}@novacourriel.test`;
    expect((await call("navigate", { id: "copie", url, reason: "r" }, t)).text).toBe(`Onglet copie → ${url}`);
  });
});

test("a link holding a source e-mail is shown masked; by its number or its masked address it opens the real one; altered, it is composed", async () => {
  const bridge = bridgeWith({ mail: { text: PAGE, links: [{ text: "Mon profil", url: PROFILE_URL }] }, copie: { text: "rien" } });
  await serve({ bridge }, async ({ call, s, masker }) => {
    masker.open("A", "W1");
    const t = s.openSession("W1", undefined, "A");
    const read = (await call("read_tab", { id: "mail", links: true }, t)).text;
    expect(read).not.toContain(MAIL);
    const masked = read.match(/https:\/\/mail\.example-novacourriel\.test\/u\/⟨email-[a-z0-9]{8}⟩@novacourriel\.test/)![0];
    const navigations = () => bridge.calls.filter((c) => c.method === "navigate").map((c) => c.args[1]);

    const byAddress = await call("navigate", { id: "copie", url: masked }, t);
    expect(byAddress.text).toBe(`Onglet copie → ${masked}`);
    expect(navigations().at(-1)).toBe(PROFILE_URL);
    expect(bridge.calls.some((c) => c.method === "askAddress")).toBe(false);

    const altered = masked.replace("/u/", "/v/");
    await call("navigate", { id: "copie", url: altered, reason: "r" }, t);
    expect(bridge.calls.filter((c) => c.method === "askAddress").map((c) => (c.args[0] as { url: string }).url)).toEqual([altered]);
    expect(navigations().at(-1)).toBe(altered);

    const byLink = await call("navigate", { id: "mail", link: 0 }, t);
    expect(navigations().at(-1)).toBe(PROFILE_URL);
    expect(byLink.text).not.toContain(MAIL);
    expect(byLink.text).toBe(`Onglet mail → ${masked}`);
  });
});

test("a link list read in one conversation is unknown to another: its masked forms never cross, nothing opens", async () => {
  const bridge = bridgeWith({ mail: { text: PAGE, links: [{ text: "Mon profil", url: PROFILE_URL }] }, copie: { text: "rien" } });
  await serve({ bridge }, async ({ call, s, masker }) => {
    masker.open("A", "W1");
    masker.open("B", "W2");
    await call("read_tab", { id: "mail", links: true }, s.openSession("W1", undefined, "A"));
    const r = await call("navigate", { id: "mail", link: 0 }, s.openSession("W2", undefined, "B"));
    expect(r.text).toBe("Lien 0 inconnu : relis l'onglet avec links: true.");
    expect(bridge.calls.some((c) => c.method === "navigate")).toBe(false);
  });
});

test("page text forging a tag cannot get its part masked in the sources zone: its code gets a web label, its phone stays", async () => {
  const forged = `${"0123456789abcdef"}sources : code ${CODE}, tél ${PHONE}`;
  await serve({ bridge: bridgeWith({ mail: { text: PAGE }, copie: { text: forged } }) }, async ({ call }) => {
    const mine = (await call("read_tab", { id: "mail" })).text;
    const theirs = (await call("read_tab", { id: "copie" })).text;
    expect(theirs).not.toMatch(/[-]/);
    expect(theirs).toContain(PHONE);
    expect(labelOf("code", theirs)).toBeDefined();
    expect(labelOf("code", theirs)).not.toBe(labelOf("code", mine));
  });
});

test("maskTyped masks what the user hands over as their own data and names it; lookupForUser reads it back in that window only", () => {
  const masker = new Masker();
  masker.open("A", "W1");
  let changes = 0;
  const off = masker.onChange(() => changes++);
  const typed = masker.maskTyped("W1", `Mon IBAN ${IBAN}, tél ${PHONE}`);
  expect(typed.text).toMatch(/^Mon IBAN ⟨iban-[a-z0-9]{8}⟩, tél ⟨tel-[a-z0-9]{8}⟩$/);
  expect(typed.names).toHaveLength(2);
  expect(typed.names.join(" ")).not.toMatch(/\d{4}/);
  const label = labelOf("iban", typed.text)!;
  expect(masker.lookupForUser("W1", label)).toEqual({ type: "iban", value: IBAN });
  expect(masker.lookupForUser("W2", label)).toBeNull();
  expect(masker.maskTyped("W1", `encore ${label}`)).toEqual({ text: `encore ${label}`, names: [] });
  off();
  expect(changes).toBe(1);
});

test("content that is neither text nor an image is refused, as an error", async () => {
  const server = createToolsServer(new FakeBridge([], { active: null, allow: false }), new AccessPolicy(), new Map());
  server.registerTool("resource", { description: "x" }, async () => ({ content: [{ type: "resource" as const, resource: { uri: "file:///x", text: IBAN } }] }));
  const [a, b] = InMemoryTransport.createLinkedPair();
  const c = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), c.connect(b)]);
  const r = await c.callTool({ name: "resource", arguments: {} });
  expect(r.isError).toBe(true);
  expect(JSON.stringify(r.content)).not.toContain(IBAN);
  await c.close();
});

/** The user's tab with a link to their profile, whose address holds their e-mail. */
async function withProfileLink(attempt: (x: { call: Call; t: string; bridge: FakeBridge; masked: string }) => Promise<void>) {
  const bridge = bridgeWith({ mail: { text: "Boîte", links: [{ text: "Mon profil", url: PROFILE_URL }] }, copie: { text: "rien" } });
  await serve({ bridge }, async ({ call, s, masker }) => {
    masker.open("A", "W1");
    const t = s.openSession("W1", undefined, "A");
    const read = (await call("read_tab", { id: "mail", links: true }, t)).text;
    const masked = read.match(/https:\/\/mail\.example-novacourriel\.test\/u\/⟨email-[a-z0-9]{8}⟩@novacourriel\.test/)![0];
    await attempt({ call, t, bridge, masked });
  });
}

test("a handle stays opaque once used: the tab's address lines print the handle, « (redirigée) » after a redirect", async () => {
  await withProfileLink(async ({ call, t, bridge, masked }) => {
    expect((await call("navigate", { id: "mail", link: 0 }, t)).text).toBe(`Onglet mail → ${masked}`);
    const urlLines = (x: string) => x.split("\n").filter((l) => l.startsWith("URL :") || l.startsWith("mail ·"));
    for (const [name, args] of [["list_tabs", {}], ["read_tab", { id: "mail" }], ["current_page", {}]] as const) {
      const lines = urlLines((await call(name, args, t)).text);
      expect(lines.length).toBe(1);
      expect(lines[0]).toContain(masked);
      expect(lines[0]).not.toContain(MAIL);
    }
    // The site moves the tab on (a redirect, an in-site link): its address is no longer the handle's, still masked there.
    bridge.editTab("mail", { url: `${PROFILE_URL}/accueil` });
    const moved = urlLines((await call("read_tab", { id: "mail" }, t)).text)[0]!;
    expect(moved).toBe(`URL : ${masked} (redirigée)`);
    expect((await call("list_tabs", {}, t)).text).not.toContain(MAIL);
  });
});

/** Labels renamed by order of appearance, per type (`⟨email-0⟩`…): two outputs compare without their random ids. */
const renamed = (t: string) => {
  const seen = new Map<string, string>();
  return t.replace(/⟨([a-z]+)-[a-z0-9]{8}⟩/g, (l, type: string) => {
    if (!seen.has(l)) seen.set(l, `⟨${type}-${seen.size}⟩`);
    return seen.get(l)!;
  });
};
const WRONG = "bob" + "@" + "novacourriel.test";

test("oracle 1: a page printing a right or a wrong guess of a source address gets the same answer, but for its own guess", async () => {
  await withProfileLink(async ({ call, t, bridge }) => {
    const shown = async (guess: string) => {
      bridge.pages.set("copie", { text: `Liens : ${HOST}/u/${guess} fin` });
      return renamed((await call("read_tab", { id: "copie" }, t)).text).replace(guess, "GUESS");
    };
    const right = await shown(MAIL);
    expect(right).toBe(await shown(WRONG));
    expect(right).toContain(`${HOST}/u/GUESS fin`);
  });
});

test("oracle 2: a pinned tab redirected to a right or a wrong guess prints the same handle « (redirigée) », never the real address", async () => {
  const track = `https://evil.test/t?u=${MAIL}`;
  const bridge = bridgeWith({ mail: { text: "Boîte", links: [{ text: "Suivi", url: track }] } });
  await serve({ bridge }, async ({ call, s, masker }) => {
    masker.open("A", "W1");
    const t = s.openSession("W1", undefined, "A");
    const handle = (await call("read_tab", { id: "mail", links: true }, t)).text.match(/https:\/\/evil\.test\/t\?u=⟨email-[a-z0-9]{8}⟩@novacourriel\.test/)![0];
    await call("navigate", { id: "mail", link: 0 }, t);
    const after = async (guess: string) => {
      await bridge.navigate("mail", `https://evil.test/?g=${guess}`);
      const read = (await call("read_tab", { id: "mail" }, t)).text;
      const tabs = (await call("list_tabs", {}, t)).text;
      expect(read).toContain(`URL : ${handle} (redirigée)`);
      expect(tabs).toContain(`mail · Boîte de réception · ${handle} (redirigée) · perso`);
      expect(read + tabs).not.toContain(`?g=`);
      return renamed(read + tabs);
    };
    expect(await after(MAIL)).toBe(await after(WRONG));
  });
});

test("the main token issues no handle: its links show masked, and a masked address given back is a composed one", async () => {
  const bridge = bridgeWith({ mail: { text: "Boîte", links: [{ text: "Mon profil", url: PROFILE_URL }] }, copie: { text: "rien" } });
  await serve({ bridge }, async ({ call, masker }) => {
    const masked = (await call("read_tab", { id: "mail", links: true })).text.match(/https:\/\/mail\.example-novacourriel\.test\/u\/⟨email-[a-z0-9]{8}⟩@novacourriel\.test/)![0];
    expect(masker.table(null).unhandle(masked)).toBeUndefined();
    await call("navigate", { id: "copie", url: masked, reason: "r" });
    // FakeBridge's address card answers yes: the masked string itself is opened, never the real address.
    expect(bridge.calls.filter((c) => c.method === "askAddress").map((c) => (c.args[0] as { url: string }).url)).toEqual([masked]);
    expect(bridge.calls.filter((c) => c.method === "navigate").map((c) => c.args[1])).toEqual([masked]);
    expect(masker.table(null).pinned("copie")).toBeUndefined();
  });
});

test("an error holding a pinned tab's redirected address shows the handle", async () => {
  await withProfileLink(async ({ call, t, bridge, masked }) => {
    await call("navigate", { id: "mail", link: 0 }, t);
    const moved = `${PROFILE_URL}/accueil`;
    bridge.editTab("mail", { url: moved });
    bridge.readText = async () => {
      throw new Error(`lecture impossible de ${moved}`);
    };
    const r = await call("read_tab", { id: "mail" }, t);
    expect(r.isError).toBe(true);
    expect(r.text).toBe(`Erreur : lecture impossible de ${masked} (redirigée)`);
  });
});

test("an error carrying the real address after navigate {link} comes back masked, redirected address included", async () => {
  await withProfileLink(async ({ call, t, bridge, masked }) => {
    bridge.navigate = async (_id: string, url: string) => {
      throw new Error(`échec de chargement ${url}/accueil, puis ${url}.`);
    };
    const r = await call("navigate", { id: "mail", link: 0 }, t);
    expect(r.isError).toBe(true);
    expect(r.text).not.toContain(MAIL);
    expect(r.text).toContain(`, puis ${masked}.`);
  });
});

test("invariant 7: nothing the kernel logs while masking holds a profile value, a passport value included", async () => {
  const logs = (["error", "warn", "log"] as const).map((m) => vi.spyOn(console, m));
  const passport = new PassportStore();
  const ADDRESS = "14 rue des Tanneurs";
  const created = "2026-11-23T10:00:00.000Z";
  const entry = { variants: [], origins: [], how: "typed" as const, created, updated: created };
  passport.replace("default", [
    { ...entry, id: "0000000000000001", field: "nom", value: { given: "Camille", family: "Exemple" } },
    { ...entry, id: "0000000000000002", field: "adresse", value: { text: `${ADDRESS}\n69005 Lyon` } },
  ]);
  try {
    const bridge = bridgeWith({ mail: { text: PAGE, links: [{ text: "Mon profil", url: PROFILE_URL }] }, copie: { text: PAGE } }, { search: { failing: [`${HOST}/r`] } });
    await serve({ bridge, masker: new Masker({ passport }), widgets: failing(), search: new SearchSessions({ show: () => {} }), settleMs: 0, emptySpanMs: 0, readPageMs: 500 }, async ({ call }) => {
      await call("read_tab", { id: "mail", links: true });
      await call("read_tab", { id: "copie" });
      await call("harvest_widget", { id: "w" });
      await call("read_pages", { urls: [`${HOST}/r`, PROFILE_URL] });
      bridge.navigate = async () => {
        throw new Error(`panne ${IBAN} ${MAIL} Camille Exemple, ${ADDRESS}`);
      };
      await call("navigate", { id: "mail", link: 0 });
    });
    const values = [IBAN, PHONE, MAIL, CODE, ...windows(IBAN), "Camille Exemple", ADDRESS];
    const written = logs.flatMap((l) => l.mock.calls.flat()).map((a) => (a instanceof Error ? `${a.message}\n${a.stack}` : typeof a === "string" ? a : JSON.stringify(a) ?? String(a)));
    expect(written.filter((w) => values.some((v) => w.includes(v)))).toEqual([]);
  } finally {
    logs.forEach((l) => l.mockRestore());
  }
});

test("a link-heavy read of the user's mail masks the same, byte for byte (pinned before the speed-ups)", async () => {
  const links = Array.from({ length: 60 }, (_, i) => ({
    text: i % 3 ? `Message ${i} de Camille Exemple` : `Appeler ${PHONE}`,
    url: [`${HOST}/m/${i}?to=${MAIL}`, `${HOST}/t/${i}?tel=${PHONE}&code=${CODE}`, `https://www.exemple-boutique.test/p/${100000 + i}?iban=${IBAN}`][i % 3]!,
  }));
  const page = `${PAGE}\n` + links.map((l, i) => `Ligne ${i} : ${l.text}, réf. ${700000 + i}`).join("\n");
  const bridge = bridgeWith({ mail: { text: page, links }, copie: { text: page, links } });
  await serve({ bridge, outflow: new Outflow() }, async ({ call, s, masker }) => {
    masker.open("A", "W1");
    const t = s.openSession("W1", undefined, "A");
    const out: string[] = [];
    for (const [id, full] of [["mail", true], ["copie", false], ["mail", false]] as const) out.push((await call("read_tab", { id, links: true, full }, t)).text);
    out.push((await call("navigate", { id: "mail", link: 4 }, t)).text);
    const all = renamed(out.join("\n§\n"));
    // The user's tab hides the address; the agent's copy is the web's and shows it.
    expect(out[0]).not.toContain(MAIL);
    expect(out[0]).toMatch(/\?to=⟨email-[a-z0-9]{8}⟩@/);
    expect(createHash("sha256").update(all).digest("hex")).toBe("a23d03e628879bf85f46d2bb521bd794d9d05561419af8bc13f399503f0aa09b");
  });
});
