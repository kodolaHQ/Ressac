import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { callMcpTool } from "../test/mcp";
import { dispatch, state, waitReady } from "./firefox";
import { launchRessac, type LaunchedRessac } from "./launch";
import type { Marionette } from "./marionette";
import { writePassport } from "./passport-file";
import { startServer } from "./server";
import { click, pressKeys, typeText, waitUi } from "./ui";

// The agent panel's chat (agent view « Discussion »): the fake docker runs test/tools/fake-claude-stream.mjs or
// fake-codex-app-server.cjs for a pipe session; each logs its argv and every line it receives to the workspace
// (fake-chat-claude.jsonl, fake-chat-codex.jsonl). A « Bonjour » turn streams « Bonjour, » then holds until the test
// writes fake-chat-go; any other text gets « Bien reçu. », « ask » asks a question, « wait » runs until interrupted.
const EMAIL = "camille.aubrac@example.org";
const CARD = '[data-testid="permission-request"]';

let w: LaunchedRessac | undefined;
let m: Marionette;
/** A profile folder a test made itself: launchRessac keeps folders passed in. */
let ownProfile: string | undefined;
afterEach(async () => {
  await w?.close();
  w = undefined;
  if (ownProfile) await rm(ownProfile, { recursive: true, force: true });
  ownProfile = undefined;
});

const root = () => join(w!.dataDir, "workspace");
type Line = { argv?: string[]; type?: string; method?: string; params?: any; message?: any; request?: any; response?: any };
const trace = (engine: "claude" | "codex" = "claude"): Line[] => {
  const f = join(root(), `fake-chat-${engine}.jsonl`);
  return existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
};
/** The user texts the fake Claude received. */
const said = () => trace().flatMap((l) => (l.type === "user" ? [typeof l.message.content === "string" ? l.message.content : l.message.content.map((b: { text?: string }) => b.text ?? "").join("")] : []));
const go = () => writeFileSync(join(root(), "fake-chat-go"), "");

async function launch(o: { writer?: "claude" | "codex"; profile?: string; env?: Record<string, string> } = {}): Promise<void> {
  w = await launchRessac({ agentView: "chat", writer: o.writer, profile: o.profile, env: o.env });
  m = w.marionette;
  await m.setContext("chrome");
  await waitReady(m);
  await click(m, '[data-testid="agent-button"]');
}
const waitAgent = <T>(body: string, args: unknown[] = [], ms = 20_000) => waitUi<T>(m, body, args, ms, "agent");
const textOf = (testid: string) => waitAgent<string>(`return [...doc.querySelectorAll('[data-testid="${testid}"]')].map((e) => e.textContent).join("\\n")`);
/** The composer takes the keyboard, `text` is typed key by key (typed, not pasted). */
async function type(text: string): Promise<void> {
  await click(m, '[data-testid="chat-input"]', { frame: "agent" });
  await waitAgent("return doc.activeElement?.dataset.testid === 'chat-input'");
  await typeText(m, text);
}
async function send(text: string): Promise<void> {
  await type(text);
  await pressKeys(m, "Enter");
  // Sent: the composer is empty again.
  await waitAgent("return doc.querySelector('[data-testid=\"chat-input\"]')?.value === ''");
}
const agentSays = (text: string) => waitAgent("return [...doc.querySelectorAll('[data-testid=\"chat-agent\"]')].some((e) => e.textContent.includes(arguments[0]))", [text]);
const sessionIds = () => trace().flatMap((l) => (l.argv?.includes("--session-id") ? [l.argv[l.argv.indexOf("--session-id") + 1]!] : []));

it("une réponse s'affiche en direct puis la discussion se termine", async () => {
  await launch({ writer: "claude" });
  await send("Bonjour");
  // Held by the fake until seen: the streamed start.
  expect(await waitAgent<string>("return doc.querySelector('[data-testid=\"chat-streaming\"]')?.textContent")).toContain("Bonjour,");
  expect(said().some((s) => s.includes("Bonjour"))).toBe(true);
  go();
  await agentSays("Bonjour, Camille.");
  await waitAgent("return !doc.querySelector('[data-testid=\"chat-streaming\"]') && !doc.querySelector('[data-testid=\"chat-stop\"]')");
  expect(await textOf("chat-user")).toContain("Bonjour");
});

it("une adresse du passeport tapée part masquée", async () => {
  const profile = (ownProfile = mkdtempSync(join(tmpdir(), "ressac-firefox-")));
  await writePassport(profile, [{ id: "e", field: "email", value: { text: EMAIL }, origins: [] }]);
  await launch({ writer: "claude", profile, env: { RESSAC_TEST_PASSPORT_CIPHER: "memory" } });
  await type(`écris à ${EMAIL}`);
  // Before the send: the chip says what will be masked.
  expect(await textOf("chat-chip")).toContain("e-mail masqué");
  await pressKeys(m, "Enter");
  await expect.poll(() => said().join("\n"), { timeout: 20_000 }).toContain("⟨email-");
  expect(said().join("\n")).not.toContain(EMAIL.split("@")[0]);
  await agentSays("Bien reçu.");
  // The user's bubble shows a chip; a click shows the value here only.
  const before = trace().length;
  await click(m, '[data-testid="chat-user"] .masked[data-label]', { frame: "agent" });
  // The label stands for the address's local part: the domain is never masked (the passport's « email-domain » warning).
  expect(await waitAgent<string>("return doc.querySelector('[data-testid=\"mask-bubble-value\"]')?.textContent")).toBe(EMAIL.split("@")[0]);
  // Must not happen: the reveal reaches the agent. Anything the click caused went before the host answered the reveal;
  // this window covers the host's write to the fake.
  await new Promise((r) => setTimeout(r, 500));
  expect(trace().length).toBe(before);
});

it("une question de l'agent devient une carte", async () => {
  await launch({ writer: "claude" });
  await send("ask");
  expect(await textOf("chat-question")).toContain("Quel train ?");
  await click(m, '[data-testid="chat-question-option"]', { frame: "agent", text: "8 h 04" });
  await expect
    .poll(() => trace().some((l) => l.type === "control_response" && JSON.stringify(l.response).includes("8 h 04")), { timeout: 20_000 })
    .toBe(true);
  await waitAgent("return !doc.querySelector('[data-testid=\"chat-question\"]')");
  expect(await textOf("chat-question-answered")).toContain("8 h 04");
});

it("deux discussions gardent chacune leur contexte", async () => {
  await launch({ writer: "claude" });
  await send("première");
  await agentSays("Bien reçu.");
  await click(m, '[data-testid="chat-new"]', { frame: "agent" });
  // The new discussion's thread: empty.
  await waitAgent("return !doc.querySelector('[data-testid=\"chat-user\"]')");
  await send("deuxième");
  await agentSays("Bien reçu.");
  await expect.poll(() => new Set(sessionIds()).size, { timeout: 20_000 }).toBe(2);
  expect(said()).toEqual(expect.arrayContaining([expect.stringContaining("première"), expect.stringContaining("deuxième")]));
  await click(m, '[data-testid="chat-picker"]', { frame: "agent" });
  // Both live, under « En cours », none paused.
  await waitAgent(
    `const list = doc.querySelector('[data-testid="chat-list"]');
     return list?.textContent.includes("En cours") && list.querySelectorAll('[data-testid="chat-row"]:not(.paused)').length === 2 && !list.querySelector(".row.paused");`,
  );
});

it("Supprimer une discussion la retire après confirmation, l'historique de l'agent aussi si la case est cochée", async () => {
  await launch({ writer: "claude" });
  go();
  await send("Bonjour");
  await agentSays("Bonjour, Camille.");
  await click(m, '[data-testid="chat-new"]', { frame: "agent" });
  await waitAgent("return !doc.querySelector('[data-testid=\"chat-user\"]')");
  await send("deuxième");
  await agentSays("Bien reçu.");
  await expect.poll(() => new Set(sessionIds()).size, { timeout: 20_000 }).toBe(2);
  const [first, second] = [...new Set(sessionIds())];
  const erased = (id: string) => readFileSync(join(root(), "fake-docker-all.log"), "utf8").split("\n").filter((l) => l.split(" ").includes("find") && l.split(" ").includes(`${id}.jsonl`));
  const rows = () => waitAgent<string[]>("return [...doc.querySelectorAll('[data-testid=\"chat-row\"]')].map((e) => e.textContent)");
  const openList = async () => {
    await click(m, '[data-testid="chat-picker"]', { frame: "agent" });
    await waitAgent("return doc.querySelector('[data-testid=\"chat-list\"]')");
  };
  await openList();
  // Both ran a turn: each row offers its engine history. The most recent first: « deuxième », then « Bonjour ».
  await waitAgent("return doc.querySelectorAll('[data-testid=\"chat-row\"]').length === 2");
  // « Bonjour » with the box left ticked (the default): the fake docker gets the deletion, the id as its own argument.
  await click(m, '.rows > .item:nth-of-type(2) [data-testid="chat-row-delete"]', { frame: "agent" });
  await waitAgent("return doc.querySelector('[data-testid=\"chat-delete-history\"]')?.checked === true");
  expect(await textOf("chat-delete-dialog")).toContain("Supprimer aussi l'historique dans Claude Code");
  await click(m, '[data-testid="chat-delete-confirm"]', { frame: "agent" });
  await expect.poll(() => erased(first!).length, { timeout: 20_000 }).toBe(1);
  await waitAgent("return doc.querySelectorAll('[data-testid=\"chat-row\"]').length === 1 && !doc.querySelector('[data-testid=\"chat-delete-dialog\"]')");
  // « deuxième », the window's active one, with the box unticked: no deletion in the workshop.
  await click(m, '[data-testid="chat-row-delete"]', { frame: "agent" });
  await click(m, '[data-testid="chat-delete-history"]', { frame: "agent" });
  await waitAgent("return doc.querySelector('[data-testid=\"chat-delete-history\"]')?.checked === false");
  await click(m, '[data-testid="chat-delete-confirm"]', { frame: "agent" });
  // The window moves on once the host has answered (here a new discussion: none is left): any deletion ran before.
  await waitAgent("return doc.querySelector('[data-testid=\"chat-list\"]') && !doc.querySelector('[data-testid=\"chat-user\"]') && [...doc.querySelectorAll('[data-testid=\"chat-row\"]')].every((e) => !e.textContent.includes('deuxième'))");
  expect(erased(second!)).toEqual([]);
  // Reopened, the list still lacks both.
  await click(m, '[data-testid="chat-list-close"]', { frame: "agent" });
  await waitAgent("return !doc.querySelector('[data-testid=\"chat-list\"]')");
  await openList();
  await waitAgent("return doc.querySelectorAll('[data-testid=\"chat-row\"]').length <= 1");
  expect((await rows()).join(" ")).not.toMatch(/Bonjour|deuxième/);
  // Deleted during its first turn (no turn ended yet): its engine history goes too, by the uuid it was started with.
  await click(m, '[data-testid="chat-list-close"]', { frame: "agent" });
  await waitAgent("return !doc.querySelector('[data-testid=\"chat-list\"]')");
  await send("wait");
  await waitAgent("return doc.querySelector('[data-testid=\"chat-stop\"]')");
  await expect.poll(() => new Set(sessionIds()).size, { timeout: 20_000 }).toBe(3);
  const third = [...new Set(sessionIds())][2]!;
  await openList();
  await click(m, '[data-testid="chat-row-delete"]', { frame: "agent" });
  await waitAgent("return doc.querySelector('[data-testid=\"chat-delete-history\"]')?.checked === true");
  await click(m, '[data-testid="chat-delete-confirm"]', { frame: "agent" });
  await expect.poll(() => erased(third).length, { timeout: 20_000 }).toBe(1);
});

it("Arrêter coupe le tour", async () => {
  await launch({ writer: "claude" });
  await send("Bonjour");
  // The fake holds the turn (no fake-chat-go): it is running until interrupted.
  await waitAgent("return doc.querySelector('[data-testid=\"chat-streaming\"]')?.textContent.includes('Bonjour,')");
  await click(m, '[data-testid="chat-stop"]', { frame: "agent" });
  await expect.poll(() => trace().some((l) => l.type === "control_request" && l.request?.subtype === "interrupt"), { timeout: 20_000 }).toBe(true);
  await waitAgent("return !doc.querySelector('[data-testid=\"chat-stop\"]')");
  // Ready again: the next message gets its answer.
  await send("encore");
  await agentSays("Bien reçu.");
});

it("Mode avancé ouvre le terminal sur la même conversation", async () => {
  await launch({ writer: "claude" });
  go();
  await send("Bonjour");
  await agentSays("Bonjour, Camille.");
  const [uuid] = sessionIds();
  expect(uuid).toMatch(/^[0-9a-f-]{36}$/);
  await click(m, '[data-testid="chat-advanced"]', { frame: "agent" });
  // The terminal's TTY session resumes the same conversation (fake-agent.mjs notes its argv).
  const args = join(root(), "fake-agent-args.json");
  await expect
    .poll(() => (existsSync(args) ? (JSON.parse(readFileSync(args, "utf8")) as string[]) : []), { timeout: 20_000 })
    .toEqual(expect.arrayContaining(["claude", "--resume", uuid]));
  const resumed = JSON.parse(readFileSync(args, "utf8")) as string[];
  expect(resumed[resumed.indexOf("--resume") + 1]).toBe(uuid);
  // A TTY exec (`docker exec -it`), not a chat pipe (`-i`).
  const execs = readFileSync(join(root(), "fake-docker-all.log"), "utf8").split("\n").filter((l) => l.includes(` --resume ${uuid}`));
  expect(execs.length).toBeGreaterThan(0);
  expect(execs.every((l) => l.startsWith("exec -it "))).toBe(true);
  await waitAgent("return doc.querySelector('.xterm-rows')?.textContent.includes('ready>')");
  await click(m, '[data-testid="chat-back"]', { frame: "agent" });
  // The discussion resumes its own conversation by id.
  await expect.poll(() => trace().some((l) => !!l.argv?.includes("--resume") && l.argv[l.argv.indexOf("--resume") + 1] === uuid), { timeout: 20_000 }).toBe(true);
  await send("encore");
  await expect.poll(() => said().some((s) => s.includes("encore")), { timeout: 20_000 }).toBe(true);
  await waitAgent("return [...doc.querySelectorAll('[data-testid=\"chat-agent\"]')].filter((e) => e.textContent.includes('Bien reçu.')).length === 1");
});

it("le sélecteur de modèle : la liste de Claude, un changement dès le message suivant, gardé par le Mode avancé et les nouvelles discussions", async () => {
  await launch({ writer: "claude" });
  await send("salut");
  await agentSays("Bien reçu.");
  await click(m, '[data-testid="chat-model-chip"]', { frame: "agent" });
  // The engine's own list, its default first (with what it runs).
  await waitAgent("return !!doc.querySelector('[data-testid=\"chat-model-sonnet\"]')");
  expect(await textOf("chat-model-default")).toContain("Par défaut");
  expect(await textOf("chat-model-default")).toContain("Opus 5.5");
  await click(m, '[data-testid="chat-model-sonnet"]', { frame: "agent" });
  await waitAgent("return doc.querySelector('[data-testid=\"chat-model-chip\"]')?.textContent.trim() === 'Sonnet' && !doc.querySelector('[data-testid=\"chat-model-menu\"]')");
  await send("encore");
  await waitAgent("return [...doc.querySelectorAll('[data-testid=\"chat-agent\"]')].filter((e) => e.textContent.includes('Bien reçu.')).length === 2");
  // Same process, set_model before the next message.
  const order = trace().flatMap((l) => (l.request?.subtype === "set_model" ? [`model:${l.request.model}`] : l.type === "user" ? ["user"] : []));
  expect(order).toEqual(["user", "model:sonnet", "user"]);
  expect(trace().filter((l) => l.argv)).toHaveLength(1);
  // « Mode avancé » goes on with the discussion's model.
  await click(m, '[data-testid="chat-advanced"]', { frame: "agent" });
  const args = join(root(), "fake-agent-args.json");
  await expect.poll(() => (existsSync(args) ? (JSON.parse(readFileSync(args, "utf8")) as string[]) : []), { timeout: 20_000 }).toEqual(expect.arrayContaining(["claude", "--resume", "--model=sonnet"]));
  await waitAgent("return doc.querySelector('.xterm-rows')?.textContent.includes('ready>')");
  await click(m, '[data-testid="chat-back"]', { frame: "agent" });
  await waitAgent("return !!doc.querySelector('[data-testid=\"chat-input\"]')");
  // A new discussion starts on it: the engine's default for new ones.
  const before = trace().filter((l) => l.argv).length;
  await click(m, '[data-testid="chat-new"]', { frame: "agent" });
  await expect.poll(() => trace().filter((l) => l.argv).length, { timeout: 20_000 }).toBeGreaterThan(before);
  expect(trace().filter((l) => l.argv).at(-1)!.argv).toContain("--model=sonnet");
  await waitAgent("return doc.querySelector('[data-testid=\"chat-model-chip\"]')?.textContent.trim() === 'Sonnet'");
});

it("panneau étroit : le modèle est en bas, l'en-tête laisse sa place à la liste des discussions, rien ne déborde", async () => {
  await launch({ writer: "claude" });
  await dispatch(m, { type: "agentPanelWidth", width: 340 });
  await waitAgent("return ui.innerWidth <= 345 && !!doc.querySelector('[data-testid=\"chat-model-chip\"]')");
  const box = await waitAgent<Record<string, number | boolean>>(`
    const r = (s) => doc.querySelector(s).getBoundingClientRect();
    const foot = doc.querySelector('[data-testid="chat-send"]').closest('.foot');
    const chip = r('[data-testid="chat-model-chip"]'), send = r('[data-testid="chat-send"]'), composer = r('[data-testid="chat-composer"]');
    return { inFoot: foot.contains(doc.querySelector('[data-testid="chat-model-chip"]')), inHeader: !!doc.querySelector('header [data-testid="chat-model-chip"]'),
      picker: r('[data-testid="chat-picker"]').width, overflow: foot.scrollWidth - foot.clientWidth, gap: send.left - chip.right, sendOut: send.right - composer.right };
  `);
  expect(box).toMatchObject({ inFoot: true, inHeader: false, overflow: 0 });
  // The discussion picker keeps room for its title; the chip sits before Send, inside the composer.
  expect(box.picker as number).toBeGreaterThan(120);
  expect(box.gap as number).toBeGreaterThanOrEqual(0);
  expect(box.sendOut as number).toBeLessThanOrEqual(0);
  // The menu opens upward, above the chip (its list is the started discussion's engine's).
  await send("salut");
  await agentSays("Bien reçu.");
  // A short title shows whole: the mode chip gives way first.
  expect(await waitAgent<boolean>("const t = doc.querySelector('[data-testid=\"chat-picker\"] .title'); return t.textContent === 'salut' && t.scrollWidth <= t.clientWidth")).toBe(true);
  await click(m, '[data-testid="chat-model-chip"]', { frame: "agent" });
  await waitAgent("return !!doc.querySelector('[data-testid=\"chat-model-sonnet\"]')");
  expect(await waitAgent<boolean>("return doc.querySelector('[data-testid=\"chat-model-menu\"]').getBoundingClientRect().bottom <= doc.querySelector('[data-testid=\"chat-model-chip\"]').getBoundingClientRect().top")).toBe(true);
  // Inside the narrow panel: never past its left or right edge.
  expect(await waitAgent<boolean>("const r = doc.querySelector('[data-testid=\"chat-model-menu\"]').getBoundingClientRect(); return r.left >= 0 && r.right <= doc.defaultView.innerWidth")).toBe(true);
  if (process.env.RESSAC_E2E_SHOTS) {
    const png = (await m.command<{ value: string }>("WebDriver:TakeScreenshot", { full: false, hash: false })).value;
    writeFileSync(join(process.env.RESSAC_E2E_SHOTS, "chat-model-340.png"), Buffer.from(png, "base64"));
  }
});

it("compte déconnecté : la carte de connexion", async () => {
  await launch();
  await waitAgent("return !!doc.querySelector('[data-testid=\"chat-login\"]')");
  await click(m, '[data-testid="chat-login-start"]', { frame: "agent" });
  // The CLI's own sign-in runs in the login card's terminal; the fake holds it until the test signs in.
  await waitAgent("return doc.querySelector('[data-testid=\"chat-login\"] .xterm-rows')?.textContent.includes('fake login: waiting')");
  expect(readFileSync(join(root(), "fake-docker-all.log"), "utf8")).toContain("claude auth login");
  go();
  writeFileSync(join(root(), "fake-claude-login-go"), "");
  await waitAgent("return !doc.querySelector('[data-testid=\"chat-login\"]') && !!doc.querySelector('[data-testid=\"chat-input\"]')");
  await send("Bonjour");
  await agentSays("Bonjour, Camille.");
});

it("Codex répond dans le chat", async () => {
  await launch({ writer: "codex" });
  // The window's first discussion is Claude's: the menu switches to Codex, in a new discussion.
  await click(m, '[data-testid="chat-mode-chip"]', { frame: "agent" });
  await click(m, '[data-testid="chat-profile-codex"]', { frame: "agent" });
  await waitAgent("return !doc.querySelector('[data-testid=\"chat-login\"]') && !!doc.querySelector('[data-testid=\"chat-input\"]')");
  await send("Bonjour");
  expect(await waitAgent<string>("return doc.querySelector('[data-testid=\"chat-streaming\"]')?.textContent")).toContain("Bonjour,");
  expect(trace("codex").some((l) => l.method === "turn/start" && l.params.input[0].text.includes("Bonjour"))).toBe(true);
  go();
  await agentSays("Bonjour, Camille.");
  await waitAgent("return !doc.querySelector('[data-testid=\"chat-streaming\"]')");
  // Never Claude's pipe: the discussion went to Codex.
  expect(said()).toEqual([]);
  // The model picker: model/list's visible models; the next turn/start carries the one picked.
  await click(m, '[data-testid="chat-model-chip"]', { frame: "agent" });
  await waitAgent("return !!doc.querySelector('[data-testid=\"chat-model-gpt-5.4\"]') && !doc.querySelector('[data-testid=\"chat-model-old\"]')");
  await click(m, '[data-testid="chat-model-gpt-5.4"]', { frame: "agent" });
  await waitAgent("return doc.querySelector('[data-testid=\"chat-model-chip\"]')?.textContent.trim() === 'GPT-5.4'");
  await send("encore");
  await expect.poll(() => trace("codex").filter((l) => l.method === "turn/start").map((l) => l.params.model ?? null), { timeout: 20_000 }).toEqual([null, "gpt-5.4"]);
});

const menuKeys = () => waitAgent<string[]>("return [...doc.querySelectorAll('[data-testid=\"chat-menu-item\"]')].map((e) => e.dataset.key)");
const activeKey = () => waitAgent<string>("return doc.querySelector('[data-testid=\"chat-menu-item\"].active')?.dataset.key ?? ''");
const inputIs = (v: string) => waitAgent("return doc.querySelector('[data-testid=\"chat-input\"]')?.value === arguments[0]", [v]);

it("le menu « / » : filtré à la frappe, au clavier, /modèle ouvre le choix du modèle et Échap rend le focus, /cherche lance la recherche", async () => {
  await launch({ writer: "claude" });
  await send("salut");
  await agentSays("Bien reçu.");
  await type("/");
  await expect.poll(menuKeys, { timeout: 10_000 }).toEqual(["model", "new", "mode", "agent", "terminal", "search", "read", "tabs", "history", "bookmarks"]);
  await typeText(m, "mod");
  await expect.poll(menuKeys, { timeout: 10_000 }).toEqual(["model", "mode"]);
  await pressKeys(m, "ArrowDown");
  await expect.poll(activeKey).toBe("mode");
  await pressKeys(m, "ArrowUp");
  await expect.poll(activeKey).toBe("model");
  await pressKeys(m, "Enter");
  // The model menu takes the keyboard on the current model; Échap closes it and focus goes back to the composer.
  await waitAgent("return !!doc.querySelector('[data-testid=\"chat-model-menu\"]') && doc.activeElement?.getAttribute('role') === 'menuitemradio'");
  await inputIs("");
  await pressKeys(m, "ArrowDown");
  await pressKeys(m, "Escape");
  await waitAgent("return !doc.querySelector('[data-testid=\"chat-model-menu\"]') && doc.activeElement?.dataset.testid === 'chat-input'");
  // Échap closes the « / » menu too, and the text stays.
  await typeText(m, "/ch");
  await expect.poll(menuKeys, { timeout: 10_000 }).toEqual(["search"]);
  await pressKeys(m, "Escape");
  await waitAgent("return !doc.querySelector('[data-testid=\"chat-command-menu\"]')");
  await typeText(m, "e");
  await waitAgent("return !doc.querySelector('[data-testid=\"chat-command-menu\"]')");
  // Back to « / »: the token changed, the menu comes back; Entrée takes /cherche, the query follows.
  for (let i = 0; i < 4; i++) await pressKeys(m, "Backspace");
  await inputIs("");
  await typeText(m, "/ch");
  await expect.poll(menuKeys, { timeout: 10_000 }).toEqual(["search"]);
  await pressKeys(m, "Enter");
  await inputIs("/cherche ");
  await typeText(m, "chats noirs");
  await pressKeys(m, "Enter");
  await inputIs("");
  // The agent gets the command's words, then the query: the search tool runs as the engine's own tool call.
  await expect.poll(() => said().at(-1), { timeout: 20_000 }).toBe("Cherchez sur le web avec search_web : chats noirs");
});

let pages: Awaited<ReturnType<typeof startServer>>;
beforeAll(async () => {
  const page = (title: string) => (_req: unknown, res: import("node:http").ServerResponse) => void res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(`<title>${title}</title><p>Contenu de ${title}</p>`);
  pages = await startServer({ routes: { "/lue": page("Page citee"), "/autre": page("Page voisine"), "/ici": page("Page ici") } });
});
afterAll(() => pages?.close());

it("@onglet : une puce dans le message, l'agent lit cet onglet sans carte dans cette discussion, un autre onglet demande toujours", { timeout: 90_000 }, async () => {
  w = await launchRessac({ agentView: "chat", writer: "claude" });
  m = w.marionette;
  await m.setContext("chrome");
  await waitReady(m);
  // Opened and shown before the panel (a tab shown with the panel open is given to the agent), each loaded once; the
  // user then looks at a third one, the tab they speak from.
  const win = (await state(m)).windows[0]!.id;
  const tabOf = async (title: string) => {
    await expect.poll(async () => Object.values((await state(m)).tabs).some((t) => t.title === title), { timeout: 20_000 }).toBe(true);
    return Object.values((await state(m)).tabs).find((t) => t.title === title)!.id;
  };
  const ids: string[] = [];
  for (const [path, title] of [["/lue", "Page citee"], ["/autre", "Page voisine"], ["/ici", "Page ici"]] as const) {
    await dispatch(m, { type: "openTab", windowId: win, url: `${pages.url}${path}`, agentReached: false });
    ids.push(await tabOf(title));
  }
  const [cited, other] = ids as [string, string];
  await click(m, '[data-testid="agent-button"]');
  // The discussion's engine has started: its session's token is there for the reads below.
  await expect.poll(() => trace().some((l) => l.argv), { timeout: 30_000 }).toBe(true);
  await type("@ong");
  await expect.poll(menuKeys, { timeout: 10_000 }).toEqual(["tab"]);
  await pressKeys(m, "Enter");
  await inputIs("@onglet ");
  await typeText(m, "citee");
  await expect.poll(menuKeys, { timeout: 10_000 }).toEqual([cited]);
  await pressKeys(m, "Enter");
  await inputIs("");
  expect(await textOf("chat-ref")).toContain("Page citee");
  await typeText(m, "resume");
  await pressKeys(m, "Enter");
  await inputIs("");
  // Title, address and id as data after the text; the chip is gone with the message.
  await expect.poll(() => said().at(-1) ?? "", { timeout: 20_000 }).toContain(`"tab":"${cited}","title":"Page citee"`);
  expect(said().at(-1)).toContain("] resume — Pages que je cite");
  await waitAgent("return !doc.querySelector('[data-testid=\"chat-ref\"]')");
  // The discussion's own agent, with its session's token.
  const folder = join(root(), ".ressac", "sessions");
  const config = join(folder, readdirSync(folder).find((f) => f.endsWith(".json"))!);
  const read = await callMcpTool(root(), "read_tab", { id: cited }, config);
  expect(read.text).toContain("Contenu de Page citee");
  // The other tab still asks (refused here), and so does the cited tab with the main token (no discussion).
  const asked = callMcpTool(root(), "read_tab", { id: other }, config);
  // A tab's card shows on that tab: put on screen after the call (showing it grants nothing).
  await dispatch(m, { type: "activateTab", id: other });
  await waitUi(m, "return doc.querySelector(arguments[0])?.textContent.includes('L\\'agent veut lire')", [CARD], 30_000);
  await click(m, `${CARD} button`, { text: "Refuser" });
  expect((await asked).text).toContain("Accès refusé");
  const main = callMcpTool(root(), "read_tab", { id: cited });
  await dispatch(m, { type: "activateTab", id: cited });
  await waitUi(m, "return doc.querySelector(arguments[0])?.textContent.includes('L\\'agent veut lire')", [CARD], 30_000);
  await click(m, `${CARD} button`, { text: "Refuser" });
  expect((await main).text).toContain("Accès refusé");
});
