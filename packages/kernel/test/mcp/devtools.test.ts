import { afterEach, expect, test, vi } from "vitest";
import { existsSync } from "node:fs";
import { readdir, writeFile, mkdir, symlink, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AccessPolicy, type DevRight } from "../../src/access/policy.js";
import { PRIVATE_TEXT, type TabInfo } from "../../src/mcp/bridge.js";
import { FakeBridge } from "../../src/mcp/fake-bridge.js";
import { startMcpServer, generateToken } from "../../src/mcp/server.js";
import { DevToolsTracking } from "../../src/devtools/tracking.js";
import { spacePaths } from "../../src/paths.js";
import { profileFiles } from "../../src/kernel.js";
import { tempFolder } from "../helpers/temp.js";

const github: TabInfo = { id: "github", title: "sveltejs/svelte", url: "https://github.com/sveltejs/svelte", space: "perso" };
const gmail: TabInfo = { id: "gmail", title: "Gmail", url: "https://mail.google.com/mail/u/0/", space: "perso" };
const vidola: TabInfo = { id: "site:vidola", title: "Vidola", url: "https://vidola-a.example/film/1", space: "", site: "vidola" };
const appTodo: TabInfo = { id: "app:todo", title: "Todo", url: "http://localhost:5280/", space: "perso", app: "todo" };

const DENIAL = "Accès refusé par l'utilisateur à cet outil sur cet onglet.";
const CUT = "Accès coupé par l'utilisateur.";

let server: Awaited<ReturnType<typeof startMcpServer>> | undefined;
let client: Client | undefined;
let tracking: DevToolsTracking | undefined;
let bridge: FakeBridge;
let policy: AccessPolicy;
let root: string;
/** Folder outside the space (browser profile) for the profiles of sites the agent did not build. */
let isPrivate: string;
const token = generateToken();

async function start(o: {
  devTools?: boolean;
  grantDev?: DevRight[];
  block?: boolean;
  profiles?: Partial<ReturnType<typeof profileFiles>>;
  /** Answer of the site app's card (absent: no card, refusal). */
  site?: boolean;
} = {}) {
  bridge = new FakeBridge([github, gmail, appTodo, vidola], {
    active: "github",
    allow: false,
    devTools: o.devTools ?? true,
    ...(o.grantDev ? { grantDev: o.grantDev } : {}),
    ...(o.block ? { block: true } : {}),
    ...(o.site !== undefined ? { widgetData: o.site } : {}),
  });
  policy = new AccessPolicy();
  root = await tempFolder();
  isPrivate = join(await tempFolder(), "profilage");
  const profiles = { ...profileFiles(spacePaths(root), isPrivate), ...o.profiles };
  server = await startMcpServer({ bridge: bridge, policy: policy, token: token, agent: "Claude", profiles: profiles });
  client = new Client({ name: "test", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
}

afterEach(async () => {
  tracking?.stop();
  tracking = undefined;
  await client?.close();
  await server?.stop();
  client = undefined;
  server = undefined;
});

const invoke = async (name: string, args: Record<string, unknown>) => {
  const r = await client!.callTool({ name, arguments: args });
  return (r.content as { type: string; text?: string }[]).map((c) => c.text ?? "").join("\n");
};
const devRequests = () => bridge.calls.filter((a) => a.method === "demanderOutilsDev");

test("without pont.outilsDev, no dev tool is listed", async () => {
  await start({ devTools: false });
  const names = (await client!.listTools()).tools.map((t) => t.name);
  expect(names).not.toContain("read_console");
  expect(names).not.toContain("request_devtools");
  expect(names).toHaveLength(6);
});

test("with pont.outilsDev, the nine dev tools are listed", async () => {
  await start();
  const names = (await client!.listTools()).tools.map((t) => t.name);
  expect(names).toEqual(
    expect.arrayContaining([
      "request_devtools", "read_console", "read_network", "read_request", "profile_performance",
      "memory_snapshot", "compare_memory", "run_js", "reload",
    ]),
  );
});

test('read_console on a third-party tab without the right: a request with rights ["console"]; granted → messages returned (timestamp, level, text)', async () => {
  await start({ grantDev: ["console"] });
  const h = Date.parse("2026-10-27T10:00:00.000Z");
  bridge.setConsole("github", [
    { timestamp: h, level: "error", text: "TypeError: x is undefined", stack: "at f (app.js:1:2)" },
    { timestamp: h + 1000, level: "log", text: "bonjour" },
  ]);
  const r = await invoke("read_console", { id: "github" });
  expect(devRequests()).toHaveLength(1);
  const [o, d] = devRequests()[0]!.args as [TabInfo, { rights: DevRight[]; reason: string; agent: string }];
  expect(o.id).toBe("github");
  expect(d).toEqual({ rights: ["console"], reason: "L'agent veut utiliser read_console.", agent: "Claude" });
  expect(r).toContain("2026-10-27T10:00:00.000Z");
  expect(r).toContain("[error] TypeError: x is undefined");
  expect(r).toContain("at f (app.js:1:2)");
  expect(r).toContain("[log] bonjour");
  // filtres
  expect(await invoke("read_console", { id: "github", level: "log" })).not.toContain("TypeError");
  expect(await invoke("read_console", { id: "github", since: h + 500 })).not.toContain("TypeError");
  expect(devRequests()).toHaveLength(1);
});

test("request_devtools: only the granted rights are returned; the unchecked ones are blocked (second call: no request, answer refused)", async () => {
  await start({ grantDev: ["console"] });
  const r = await invoke("request_devtools", { id: "github", rights: ["console", "network"], reason: "Déboguer l'erreur" });
  expect(r).toContain("Droits accordés : console");
  expect(r).not.toMatch(/accordés : .*reseau/);
  expect(policy.devRights(github)).toEqual(["console"]);
  expect(policy.canAsk("github", "network")).toBe(false);
  expect((devRequests()[0]!.args[1] as { reason: string }).reason).toBe("Déboguer l'erreur");
  expect(await invoke("request_devtools", { id: "github", rights: ["network"], reason: "encore" })).toBe(DENIAL);
  expect(await invoke("read_network", { id: "github" })).toBe(DENIAL);
  expect(devRequests()).toHaveLength(1);
});

test("after politique.interactionUtilisateur, the refused right can be asked again", async () => {
  await start({ grantDev: [] });
  expect(await invoke("read_console", { id: "github" })).toBe(DENIAL);
  expect(await invoke("read_console", { id: "github" })).toBe(DENIAL);
  expect(devRequests()).toHaveLength(1);
  policy.userInteraction(github);
  expect(await invoke("read_console", { id: "github" })).toBe(DENIAL);
  expect(devRequests()).toHaveLength(2);
});

test("without demanderOutilsDev on the bridge: immediate refusal", async () => {
  await start();
  expect(await invoke("read_console", { id: "github" })).toBe(DENIAL);
  expect(bridge.askDevTools).toBeUndefined();
});

test("built (app:todo): read_console and run_js without a request", async () => {
  await start({ grantDev: [] });
  policy.tabOpenedByAgent(appTodo);
  bridge.setConsole("app:todo", [{ timestamp: 0, level: "warn", text: "attention" }]);
  expect(await invoke("read_console", { id: "app:todo" })).toContain("[warn] attention");
  expect(await invoke("run_js", { id: "app:todo", code: "1 + 1" })).toBe(JSON.stringify({ code: "1 + 1" }));
  expect(await invoke("run_js", { id: "app:todo", code: "throw boom" })).toContain("Exception : boom");
  expect(await invoke("reload", { id: "app:todo", no_cache: true })).toContain("rechargé");
  expect(bridge.calls.some((a) => a.method === "recharger" && a.args[1] === true)).toBe(true);
  expect(devRequests()).toHaveLength(0);
});

test("run_js truncates a value that is too long", async () => {
  await start();
  policy.tabOpenedByAgent(appTodo);
  const r = await invoke("run_js", { id: "app:todo", code: "x".repeat(3000) });
  expect(r.endsWith("… [tronqué]")).toBe(true);
  expect(r.length).toBeLessThan(2100);
});

test("read_network on a third-party tab masks Cookie and access_token; on a built one, nothing is masked", async () => {
  await start({ grantDev: ["network"] });
  const request = {
    id: "r1", timestamp: 0, method: "GET", url: "https://github.com/api?access_token=abc123&page=2", status: 200,
    durationMs: 12, size: 345, type: "Fetch", requestHeaders: { Cookie: "session=xyz" }, responseHeaders: { "Content-Type": "application/json" },
  };
  bridge.setNetwork("github", [request]);
  bridge.setNetwork("app:todo", [request]);
  const list = await invoke("read_network", { id: "github" });
  expect(list).toContain("r1");
  expect(list).toContain("access_token=«masqué»&page=2");
  expect(list).not.toContain("abc123");
  // the filter applies to the displayed URL: it does not allow guessing a secret
  expect(await invoke("read_network", { id: "github", filter: "abc123" })).not.toContain("r1");
  const detail = await invoke("read_request", { id: "github", request: "r1" });
  expect(detail).toContain("Cookie: «masqué»");
  expect(detail).not.toContain("session=xyz");
  expect(detail).toContain("Content-Type: application/json");
  expect(detail).toContain("Corps de r1");
  expect(await invoke("read_request", { id: "github", request: "inconnue" })).toContain("introuvable");

  policy.tabOpenedByAgent(appTodo);
  expect(await invoke("read_network", { id: "app:todo" })).toContain("access_token=abc123");
  expect(await invoke("read_request", { id: "app:todo", request: "r1" })).toContain("Cookie: session=xyz");
});

test("profile_performance: on a third-party site, the .cpuprofile stays outside the space (reference profile:…); a built one writes under /workspace", async () => {
  await start({ grantDev: ["performance"] });
  const r = await invoke("profile_performance", { id: "github", duration_s: 2 });
  expect(bridge.calls.find((a) => a.method === "profiler")!.args[1]).toEqual({ durationMs: 2000 });
  expect(r).toContain("calculer");
  expect(r).toContain("Nodes : 42");
  const reference = /Profil : (profile:\S+\.cpuprofile)$/.exec(r)?.[1];
  expect(reference).toMatch(/^profile:[^:/]+-profile_performance\.cpuprofile$/);
  expect(existsSync(join(isPrivate, reference!.slice("profile:".length)))).toBe(true);
  expect(existsSync(join(root, ".webaios", "profilage"))).toBe(false);

  // a built app writes in its project
  policy.tabOpenedByAgent(appTodo);
  const app = await invoke("profile_performance", { id: "app:todo", reload: true });
  expect(app).toMatch(/Profil : \/workspace\/projets\/todo\/\.webaios\/profilage\/\S+\.cpuprofile/);
  // a built demo, in .webaios/profilage
  const demo = await bridge.openTab("http://localhost:5281/");
  policy.tabOpenedByAgent(demo);
  const d = await invoke("profile_performance", { id: demo.id, duration_s: 1 });
  expect(d).toMatch(/Profil : \/workspace\/\.webaios\/profilage\/\S+\.cpuprofile$/);
});

test("memory_snapshot then compare_memory", async () => {
  await start({ grantDev: ["performance"] });
  const a = await invoke("memory_snapshot", { id: "github" });
  expect(a).toContain("Total :");
  expect(a).toContain("Fuite : 2 objets");
  const pathA = /Instantané : (\S+\.heapsnapshot)/.exec(a)![1]!;
  expect(pathA).toMatch(/^profile:[^/]+\.heapsnapshot$/);
  bridge.growHeap();
  const b = await invoke("memory_snapshot", { id: "github" });
  const pathB = /Instantané : (\S+\.heapsnapshot)/.exec(b)![1]!;
  expect(pathB).not.toBe(pathA);
  const c = await invoke("compare_memory", { id: "github", a: pathA, b: pathB });
  expect(c).toContain("Fuite +1");
  // outside the profile folders: refused
  expect(await invoke("compare_memory", { id: "github", a: "/workspace/AGENTS.md", b: pathB })).toBe(
    "Instantané illisible : /workspace/AGENTS.md.",
  );
  expect(await invoke("compare_memory", { id: "github", a: "/workspace/.webaios/profilage/../mcp.json", b: pathB })).toBe(
    "Instantané illisible : /workspace/.webaios/profilage/../mcp.json.",
  );
  // a file in the folder that is not a snapshot: never its content in the answer
  await mkdir(join(root, ".webaios", "profilage"), { recursive: true });
  await writeFile(join(root, ".webaios", "profilage", "faux.heapsnapshot"), "secret de l'utilisateur");
  const fake = await invoke("compare_memory", { id: "github", a: "/workspace/.webaios/profilage/faux.heapsnapshot", b: pathB });
  expect(fake).toBe("Instantané illisible : /workspace/.webaios/profilage/faux.heapsnapshot.");
  // a reference never leaves the private folder
  for (const ref of ["profile:../x.heapsnapshot", "profile:", "profile:inconnu.heapsnapshot"]) {
    expect(await invoke("compare_memory", { id: "github", a: ref, b: pathB })).toBe(`Instantané illisible : ${ref}.`);
  }
  await symlink(join(root, "AGENTS.md"), join(isPrivate, "lien.heapsnapshot"));
  expect(await invoke("compare_memory", { id: "github", a: "profile:lien.heapsnapshot", b: pathB })).toBe(
    "Instantané illisible : profile:lien.heapsnapshot.",
  );
});

test("cut during memory_snapshot (bloquer: true): answer « Accès coupé par l'utilisateur. », no file left", async () => {
  await start({ grantDev: ["performance"], block: true });
  const call = invoke("memory_snapshot", { id: "github" });
  await vi.waitFor(() => expect(bridge.calls.some((a) => a.method === "instantaneMemoire")).toBe(true));
  expect(policy.state().github?.running).toBe(true);
  policy.cut("github", "performance");
  expect(await call).toBe(CUT);
  expect(policy.state().github?.running ?? false).toBe(false);
  const folder = isPrivate;
  expect(existsSync(folder) ? await readdir(folder) : []).toEqual([]);
});

test("cut while the profile is being written: the partial file is erased", async () => {
  let written = "";
  await start({
    grantDev: ["performance"],
    profiles: {
      writeProfile: async (_o, name, content) => {
        const folder = join(root, ".webaios", "profilage");
        await mkdir(folder, { recursive: true });
        await writeFile(join(folder, name), content);
        written = join(folder, name);
        policy.cut("github");
        return `/workspace/.webaios/profilage/${name}`;
      },
    },
  });
  expect(await invoke("profile_performance", { id: "github" })).toBe(CUT);
  expect(written).not.toBe("");
  await vi.waitFor(() => expect(existsSync(written)).toBe(false));
});

test("the tab changes site during the request: nothing is granted", async () => {
  await start({ grantDev: ["console"] });
  const ask = bridge.askDevTools!.bind(bridge);
  bridge.askDevTools = async (o, d) => {
    await bridge.navigate(o.id, "https://autre.example/");
    return ask(o, d);
  };
  expect(await invoke("read_console", { id: "github" })).toBe(DENIAL);
  expect(policy.devRights({ ...github, url: "https://autre.example/" })).toEqual([]);
  expect(policy.devRights(github)).toEqual([]);
});

test("two simultaneous requests for the same tab: a single card", async () => {
  await start({ grantDev: ["console"] });
  const ask = bridge.askDevTools!.bind(bridge);
  let release!: () => void;
  const lock = new Promise<void>((ok) => (release = ok));
  bridge.askDevTools = async (o, d) => {
    const r = ask(o, d);
    await lock;
    return r;
  };
  bridge.setConsole("github", [{ timestamp: 0, level: "log", text: "salut" }]);
  const a = invoke("read_console", { id: "github" });
  await vi.waitFor(() => expect(devRequests()).toHaveLength(1));
  const b = invoke("read_console", { id: "github" });
  await new Promise((r) => setTimeout(r, 50));
  release();
  expect(await a).toContain("salut");
  expect(await b).toContain("salut");
  expect(devRequests()).toHaveLength(1);
});

test("DevToolsTracking: attaches at the first right, detaches when everything is cut; DevToolsBusy → the tool returns the message", async () => {
  await start({ grantDev: ["console"] });
  tracking = new DevToolsTracking(policy, bridge.devTools!, () => bridge.listTabs());
  const callsOf = (m: string, id: string) => bridge.calls.filter((a) => a.method === m && a.args[0] === id).length;

  policy.grantDev(github, ["console"], []);
  await vi.waitFor(() => expect(tracking!.attaches.has("github")).toBe(true));
  policy.grantDev(github, ["network"], []);
  await new Promise((r) => setTimeout(r, 20));
  expect(callsOf("attacher", "github")).toBe(1);

  policy.cut("github", "console");
  await new Promise((r) => setTimeout(r, 20));
  expect(tracking.attaches.has("github")).toBe(true);
  policy.cut("github");
  await vi.waitFor(() => expect(tracking!.attaches.has("github")).toBe(false));
  expect(callsOf("detacher", "github")).toBe(1);

  // The user opened their tools on Gmail
  bridge.occupy("gmail");
  policy.grantDev(gmail, ["console"], []);
  await vi.waitFor(() => expect(tracking!.busy.has("gmail")).toBe(true));
  expect(tracking.attaches.has("gmail")).toBe(false);
  expect(await invoke("read_console", { id: "gmail" })).toBe("Les outils de développement de l'utilisateur sont ouverts sur cet onglet.");
});

test("profileFiles: refuses a path outside the profile folders", async () => {
  const r = await tempFolder();
  const p = profileFiles(spacePaths(r));
  const path = await p.writeProfile(appTodo, "x.heapsnapshot", "{}", true);
  expect(path).toBe("/workspace/projets/todo/.webaios/profilage/x.heapsnapshot");
  expect(await p.readProfile(path)).toBe("{}");
  await p.deleteProfile(path);
  expect(existsSync(join(r, "projets", "todo", ".webaios", "profilage", "x.heapsnapshot"))).toBe(false);
  for (const fake of ["/workspace/AGENTS.md", "/workspace/.webaios/mcp.json", "/workspace/projets/todo/../../.webaios/mcp.json", "/etc/passwd", "relatif.cpuprofile"]) {
    await expect(p.readProfile(fake)).rejects.toThrow();
    await expect(p.deleteProfile(fake)).rejects.toThrow();
  }
  await expect(p.writeProfile({ ...appTodo, app: "../x" }, "y.cpuprofile", "{}", true)).rejects.toThrow();
  await expect(p.writeProfile(github, "../y.cpuprofile", "{}", true)).rejects.toThrow();
  // without a private folder, a third-party site's profile is not saved (never in the space)
  await expect(p.writeProfile(github, "z.cpuprofile", "{}", false)).rejects.toThrow(/indisponible/);
  expect(existsSync(join(r, ".webaios", "profilage", "z.cpuprofile"))).toBe(false);
});

test("profileFiles: a profiling folder as a symbolic link is refused, on write as on read", async () => {
  const r = await tempFolder();
  const outside = await tempFolder();
  await writeFile(join(outside, "x.heapsnapshot"), "secret");
  await mkdir(join(r, ".webaios"), { recursive: true });
  await symlink(outside, join(r, ".webaios", "profilage"));
  const p = profileFiles(spacePaths(r));
  await expect(p.writeProfile(github, "y.cpuprofile", "{}", true)).rejects.toThrow(/hors des profils/);
  expect(existsSync(join(outside, "y.cpuprofile"))).toBe(false);
  await expect(p.readProfile("/workspace/.webaios/profilage/x.heapsnapshot")).rejects.toThrow(/hors des profils/);
  await expect(p.deleteProfile("/workspace/.webaios/profilage/x.heapsnapshot")).rejects.toThrow(/hors des profils/);
  expect(existsSync(join(outside, "x.heapsnapshot"))).toBe(true);
  // a link higher up (the project folder) too
  await mkdir(join(r, "projets"), { recursive: true });
  await symlink(outside, join(r, "projets", "todo"));
  await expect(p.writeProfile(appTodo, "z.cpuprofile", "{}", true)).rejects.toThrow(/hors des profils/);
  expect(existsSync(join(outside, ".webaios"))).toBe(false);
});

test("profileFiles: a file as a symbolic link is neither read, nor erased, nor overwritten", async () => {
  const r = await tempFolder();
  const outside = await tempFolder();
  const target = join(outside, "cible.txt");
  await writeFile(target, "secret");
  const folder = join(r, ".webaios", "profilage");
  await mkdir(folder, { recursive: true });
  await symlink(target, join(folder, "lien.heapsnapshot"));
  const p = profileFiles(spacePaths(r));
  await expect(p.readProfile("/workspace/.webaios/profilage/lien.heapsnapshot")).rejects.toThrow(/hors des profils/);
  await expect(p.deleteProfile("/workspace/.webaios/profilage/lien.heapsnapshot")).rejects.toThrow(/hors des profils/);
  await expect(p.writeProfile(github, "lien.heapsnapshot", "écrasé", true)).rejects.toThrow();
  expect(await readFile(target, "utf8")).toBe("secret");
  expect(existsSync(join(folder, "lien.heapsnapshot"))).toBe(true);
});

test("read_console and read_network: at most 100,000 characters, the most recent entries kept", async () => {
  await start();
  policy.tabOpenedByAgent(appTodo);
  bridge.setConsole(
    "app:todo",
    Array.from({ length: 100 }, (_, i) => ({ timestamp: i, level: "log" as const, text: `m${i}-`.padEnd(1500, "x") })),
  );
  const r = await invoke("read_console", { id: "app:todo" });
  expect(r.length).toBeLessThanOrEqual(100_000);
  const first = r.split("\n")[0]!;
  expect(first).toMatch(/^\d+ entrées plus anciennes omises\.$/);
  const omitted = Number(first.split(" ")[0]);
  expect(omitted).toBeGreaterThan(0);
  expect(r).toContain("m99-");
  expect(r).not.toContain(`m${omitted - 1}-`);
  expect(r).toContain(`m${omitted}-`);

  bridge.setNetwork(
    "app:todo",
    Array.from({ length: 200 }, (_, i) => ({
      id: `r${i}`, timestamp: i, method: "GET", url: `http://localhost:5280/${i}-${"y".repeat(1000)}`,
      requestHeaders: {}, responseHeaders: {},
    })),
  );
  const network = await invoke("read_network", { id: "app:todo" });
  expect(network.length).toBeLessThanOrEqual(100_000);
  expect(network).toMatch(/^\d+ entrées plus anciennes omises\.\n/);
  expect(network).toContain("r199 ·");
  // under the limit: nothing omitted
  bridge.setConsole("app:todo", [{ timestamp: 0, level: "log", text: "court" }]);
  expect(await invoke("read_console", { id: "app:todo" })).not.toContain("omises");
});

test("site change during memory_snapshot: « L'onglet a changé de site : accès retiré. »", async () => {
  await start({ grantDev: ["performance"], block: true });
  const call = invoke("memory_snapshot", { id: "github" });
  await vi.waitFor(() => expect(bridge.calls.some((a) => a.method === "instantaneMemoire")).toBe(true));
  await bridge.navigate("github", "https://autre.example/");
  policy.tabNavigated("github", "https://autre.example/");
  expect(await call).toBe("L'onglet a changé de site : accès retiré.");
});

test("the site changes between the grant and the call: the bridge is not called", async () => {
  await start();
  policy.tabOpenedByAgent(appTodo);
  const listTool = bridge.listTabs.bind(bridge);
  let n = 0;
  bridge.listTabs = async () => {
    // 1 : obtenir ; 2 : relecture avant l'appel
    if (++n === 2) {
      await bridge.navigate("app:todo", "https://autre.example/");
      policy.tabNavigated("app:todo", "https://autre.example/");
    }
    return listTool();
  };
  expect(await invoke("run_js", { id: "app:todo", code: "1" })).toBe("L'onglet a changé de site : accès retiré.");
  expect(bridge.calls.some((a) => a.method === "executer")).toBe(false);
});

test("an error after the profile is written also erases the file", async () => {
  await start({ grantDev: ["performance"] });
  const folder = isPrivate;
  bridge.devTools!.memorySnapshot = async () => "pas du json";
  const r = await invoke("memory_snapshot", { id: "github" });
  expect(r).toMatch(/^Erreur/);
  expect(existsSync(folder) ? await readdir(folder) : []).toEqual([]);
});

test("cut answers right away even if the bridge ignores the signal; its late result writes no file", async () => {
  await start({ grantDev: ["performance"] });
  const folder = isPrivate;
  let finish!: (s: string) => void;
  bridge.devTools!.memorySnapshot = () => new Promise<string>((ok) => (finish = ok));
  const call = invoke("memory_snapshot", { id: "github" });
  await vi.waitFor(() => expect(finish).toBeDefined());
  policy.cut("github", "performance");
  expect(await call).toBe(CUT);
  finish(JSON.stringify({ snapshot: { meta: { node_fields: [], node_types: [] } }, nodes: [], strings: [] }));
  await new Promise((r) => setTimeout(r, 50));
  expect(existsSync(folder) ? await readdir(folder) : []).toEqual([]);
});

test("profileFiles: a third-party site writes in the private folder and receives a reference profile:<name>", async () => {
  const r = await tempFolder();
  const folder = join(await tempFolder(), "profilage");
  const p = profileFiles(spacePaths(r), folder);
  const ref = await p.writeProfile(github, "x.heapsnapshot", "{}", false);
  expect(ref).toBe("profile:x.heapsnapshot");
  expect(existsSync(join(folder, "x.heapsnapshot"))).toBe(true);
  expect(existsSync(join(r, ".webaios"))).toBe(false);
  expect(await p.readProfile(ref)).toBe("{}");
  await expect(p.writeProfile(github, "x.heapsnapshot", "écrasé", false)).rejects.toThrow();
  for (const fake of ["profile:../x.heapsnapshot", "profile:a/b", "profile:", "profile:.."]) {
    await expect(p.readProfile(fake)).rejects.toThrow();
    await expect(p.deleteProfile(fake)).rejects.toThrow();
  }
  await p.deleteProfile(ref);
  expect(existsSync(join(folder, "x.heapsnapshot"))).toBe(false);
  await p.deleteProfile(ref); // already erased: without error
});

test("page without an origin (about:blank, data:, file:): immediate refusal, no card", async () => {
  await start({ grantDev: ["console"] });
  for (const url of ["about:blank", "data:text/html,<p>x</p>", "file:///Users/someone/a.html"]) {
    const o = await bridge.openTab(url);
    expect(await invoke("read_console", { id: o.id })).toBe(DENIAL);
    expect(await invoke("request_devtools", { id: o.id, rights: ["console"], reason: "voir" })).toBe(DENIAL);
  }
  expect(devRequests()).toHaveLength(0);
});

test("the reason shown on the card is bounded to 300 characters (…)", async () => {
  await start({ grantDev: ["console"] });
  await invoke("request_devtools", { id: "github", rights: ["console"], reason: "a".repeat(1000) });
  const reason = (devRequests()[0]!.args[1] as { reason: string }).reason;
  expect(reason).toHaveLength(300);
  expect(reason.endsWith("…")).toBe(true);
  await invoke("request_devtools", { id: "gmail", rights: ["console"], reason: "b".repeat(300) });
  expect((devRequests()[1]!.args[1] as { reason: string }).reason).toBe("b".repeat(300));
});

test("new conversation during the card: the card is withdrawn (signal) and a late answer grants nothing", async () => {
  await start({ grantDev: ["console"] });
  let signal: AbortSignal | undefined;
  let reply!: (d: DevRight[]) => void;
  bridge.askDevTools = (_o, _d, s) => {
    signal = s;
    return new Promise<DevRight[]>((ok) => (reply = ok));
  };
  const call = invoke("read_console", { id: "github" });
  await vi.waitFor(() => expect(signal).toBeDefined());
  expect(signal!.aborted).toBe(false);
  policy.reset();
  expect(signal!.aborted).toBe(true);
  reply(["console"]); // The user clicks anyway (or the browser ignores the signal)
  expect(await call).toBe(DENIAL);
  expect(policy.devRights(github)).toEqual([]);
  expect(policy.canAsk("github", "console")).toBe(true);
});

test("read_console masks the tokens in URLs in the messages and stacks of a third-party site; not on a built one", async () => {
  await start({ grantDev: ["console"] });
  const messages = [
    {
      timestamp: 0,
      level: "error" as const,
      text: "GET https://api.github.com/user?access_token=abc123&page=2 401",
      stack: "at f (https://github.com/app.js?sig=zzz999:1:2)",
    },
  ];
  bridge.setConsole("github", messages);
  bridge.setConsole("app:todo", messages);
  const r = await invoke("read_console", { id: "github" });
  expect(r).toContain("https://api.github.com/user?access_token=«masqué»&page=2 401");
  expect(r).toContain("at f (https://github.com/app.js?sig=«masqué»)");
  expect(r).not.toContain("abc123");
  expect(r).not.toContain("zzz999");
  policy.tabOpenedByAgent(appTodo);
  const raw = await invoke("read_console", { id: "app:todo" });
  expect(raw).toContain("access_token=abc123");
  expect(raw).toContain("sig=zzz999");
});

test("DevToolsTracking: a tab that keeps its rights on another origin (relaunched app) is detached then reattached", async () => {
  await start();
  tracking = new DevToolsTracking(policy, bridge.devTools!, () => bridge.listTabs());
  const calls = () => bridge.calls.filter((a) => ["attacher", "detacher"].includes(a.method) && a.args[0] === "app:todo").map((a) => a.method);
  policy.built(appTodo);
  await vi.waitFor(() => expect(calls()).toEqual(["attacher"]));
  // relaunched on another port: the window navigates, it is built again on its new origin
  await bridge.navigate("app:todo", "http://localhost:5290/");
  policy.tabNavigated("app:todo", "http://localhost:5290/");
  policy.built({ ...appTodo, url: "http://localhost:5290/" });
  await vi.waitFor(() => expect(calls()).toEqual(["attacher", "detacher", "attacher"]));
  expect(tracking.attaches.has("app:todo")).toBe(true);
  // same origin, other page: nothing moves
  await bridge.navigate("app:todo", "http://localhost:5290/autre");
  policy.tabNavigated("app:todo", "http://localhost:5290/autre");
  await new Promise((r) => setTimeout(r, 20));
  expect(calls()).toEqual(["attacher", "detacher", "attacher"]);
});

test("private space: each dev tool answers PRIVATE_TEXT, without a card or a debugger call", async () => {
  await start({ grantDev: ["console", "network", "performance", "act"] });
  bridge.makePrivate("github");
  const calls: [string, Record<string, unknown>][] = [
    ["request_devtools", { id: "github", rights: ["console"], reason: "déboguer" }],
    ["read_console", { id: "github" }],
    ["read_network", { id: "github" }],
    ["read_request", { id: "github", request: "1" }],
    ["profile_performance", { id: "github", duration_s: 1 }],
    ["memory_snapshot", { id: "github" }],
    ["compare_memory", { id: "github", a: "x", b: "y" }],
    ["run_js", { id: "github", code: "1" }],
    ["reload", { id: "github" }],
  ];
  for (const [name, args] of calls) {
    const r = await client!.callTool({ name, arguments: args });
    expect((r.content as { text: string }[])[0]!.text, name).toBe(PRIVATE_TEXT);
    expect(r.isError, name).toBeFalsy();
  }
  expect(devRequests()).toHaveLength(0);
  expect(bridge.calls.filter((a) => !["listerOnglets"].includes(a.method))).toEqual([]);
});

test("private space during a call: it is cut and answers PRIVATE_TEXT", async () => {
  await start({ grantDev: ["performance"], block: true });
  const r = invoke("profile_performance", { id: "github", duration_s: 30 });
  await vi.waitFor(() => expect(bridge.calls.some((a) => a.method === "profiler")).toBe(true));
  bridge.makePrivate("github");
  policy.tabClosed("github"); // what the browser does when the tab becomes private
  expect(await r).toBe(PRIVATE_TEXT);
});

// ——— Site app windows: the app's grant AND the dev tools' ———

const siteCards = () => bridge.calls.filter((a) => a.method === "demanderDonneesWidget");

test("read_console with the site's grant but without a dev right: refused", async () => {
  await start({ grantDev: [], site: true });
  policy.grantSiteRead("vidola");
  bridge.setConsole("site:vidola", [{ timestamp: 0, level: "error", text: "secret de la page" }]);
  expect(await invoke("read_console", { id: "site:vidola" })).toBe(DENIAL);
  expect(devRequests()).toHaveLength(1);
  expect(siteCards()).toHaveLength(0);
  expect(bridge.calls.some((a) => a.method === "console")).toBe(false);
  expect(await invoke("read_network", { id: "site:vidola" })).toBe(DENIAL);
  expect(bridge.calls.some((a) => a.method === "reseau")).toBe(false);
});

test("read_console with the dev right but without the site's grant: the app's card, refused → refused, without a tools card", async () => {
  await start({ grantDev: ["console", "network"], site: false });
  bridge.setConsole("site:vidola", [{ timestamp: 0, level: "error", text: "secret de la page" }]);
  // A dev right already held is not enough.
  policy.grantDev(vidola, ["console"], []);
  expect(await invoke("read_console", { id: "site:vidola" })).toBe(DENIAL);
  expect(siteCards().map((c) => c.args[0])).toEqual([{ id: "vidola", name: "Vidola", agent: "Claude", kind: "site" }]);
  expect(devRequests()).toHaveLength(0);
  expect(bridge.calls.some((a) => a.method === "console")).toBe(false);
  expect(await invoke("request_devtools", { id: "site:vidola", rights: ["network"], reason: "voir" })).toBe(DENIAL);
  expect(devRequests()).toHaveLength(0);
});

test("read_console on a site app whose site.json was rewritten (other hash): the app's card comes back first", async () => {
  await start({ grantDev: ["console"], site: true });
  bridge.editTab("site:vidola", { hash: "e1" });
  bridge.setConsole("site:vidola", [{ timestamp: 0, level: "error", text: "message" }]);
  expect(await invoke("read_console", { id: "site:vidola" })).toContain("message");
  expect(siteCards()).toHaveLength(1);
  bridge.editTab("site:vidola", { hash: "e2" });
  expect(policy.devRights({ ...vidola, hash: "e2" })).toEqual([]);
  await invoke("read_console", { id: "site:vidola" });
  expect(siteCards()).toHaveLength(2);
});

test("read_console: site.json rewritten during the app's card (other hash): nothing is read", async () => {
  await start({ grantDev: ["console"] });
  bridge.editTab("site:vidola", { hash: "e1" });
  bridge.setConsole("site:vidola", [{ timestamp: 0, level: "error", text: "secret de la page" }]);
  let reply: ((yes: boolean) => void) | undefined;
  bridge.askWidgetData = () => new Promise<boolean>((ok) => (reply = ok));
  const r = invoke("read_console", { id: "site:vidola" });
  await vi.waitFor(() => expect(reply).toBeDefined());
  bridge.editTab("site:vidola", { hash: "autre" });
  reply!(true);
  expect(await r).toBe(DENIAL);
  expect(bridge.calls.some((a) => a.method === "console")).toBe(false);
});

test("read_console on a site app: both grants → the messages, URLs masked (the site is not built by the agent)", async () => {
  await start({ grantDev: ["console"], site: true });
  bridge.setConsole("site:vidola", [{ timestamp: 0, level: "error", text: "échec https://vidola-a.example/api?token=abc" }]);
  const r = await invoke("read_console", { id: "site:vidola" });
  expect(r).toContain("[error] échec");
  expect(r).not.toContain("token=abc");
  expect(r).toContain("token=«masqué»");
  expect(siteCards()).toHaveLength(1);
  expect(devRequests()).toHaveLength(1);
  // New conversation: both grants drop.
  policy.reset();
  bridge.calls.length = 0;
  await invoke("read_console", { id: "site:vidola" });
  expect(siteCards()).toHaveLength(1);
});
