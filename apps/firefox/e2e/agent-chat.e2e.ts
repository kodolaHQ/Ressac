import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { waitReady } from "./firefox";
import { launchRessac, type LaunchedRessac } from "./launch";
import type { Marionette } from "./marionette";
import { writePassport } from "./passport-file";
import { click, pressKeys, typeText, waitUi } from "./ui";

// The agent panel's chat (agent view « Discussion »): the fake docker runs test/tools/fake-claude-stream.mjs or
// fake-codex-app-server.cjs for a pipe session; each logs its argv and every line it receives to the workspace
// (fake-chat-claude.jsonl, fake-chat-codex.jsonl). A « Bonjour » turn streams « Bonjour, » then holds until the test
// writes fake-chat-go; any other text gets « Bien reçu. », « ask » asks a question, « wait » runs until interrupted.
const EMAIL = "camille.aubrac@example.org";

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
});
