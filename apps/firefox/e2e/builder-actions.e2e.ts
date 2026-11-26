import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Action } from "../shared/api";
import { callMcpTool } from "../test/mcp";
import { actionsDataDir, listen, openAction, runsOnDisk, tid, uiQueries, waitKernel, writeAction, writeRunnableAction, type TestServer } from "./actions";
import { dispatch, state, waitReady } from "./firefox";
import { launchRessac, type LaunchedRessac } from "./launch";
import type { Marionette } from "./marionette";
import { click, inUi, missingApi, agentPanelReady, pressKeys, waitUi } from "./ui";

// The workflow builder opened on an action (ressac://workflow/action/<id>): the Action panel, ▶ Lancer with the input, a replay whose page shows in the preview without becoming the last
// result. Gemma absent: the fallback layout.

const GITLAB_INSTRUCTION = "Un tableau des tickets, les plus urgents d'abord";
const NAME = "Tickets GitLab";
const codeGitlab = (mark: string) => `export default async (_e, w) => [{ titre: "ticket-" + w.input + "-${mark}" }];`;
/** An action with an input: a `code` block that gives the input (and `marque`), then the output to the page. */
const writeGitlab = (id: string, mark = "un") =>
  writeAction(w.dataDir, id, {
    name: NAME,
    input: { label: "Projet" },
    sources: { public: ["gitlab.com"] },
    layout: GITLAB_INSTRUCTION,
    maxDurationMinutes: 5,
    workflow: {
      version: 1,
      blocks: [
        { id: "lire", type: "code", params: { source: "lire.mjs" } },
        { id: "sortie", type: "output", params: { to: "page" } },
      ],
      links: [{ from: "lire", to: "sortie" }],
    },
    files: { "lire.mjs": codeGitlab(mark) },
  });
const actionDir = (id: string) => path.join(w.dataDir, "workspace", "actions", id);

let w: LaunchedRessac;
let m: Marionette;
let q: ReturnType<typeof uiQueries>;
let ollama: TestServer;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const visible = (selector: string, ms = 30_000) => waitUi(m, "const e = doc.querySelector(arguments[0]); return !!e && e.getBoundingClientRect().height > 0;", [selector], ms);
async function poll<T>(read: () => Promise<T> | T, ok: (v: T) => boolean, what: string, ms = 60_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (ok(v)) return v;
    if (Date.now() > deadline) throw new Error(`${what}: got ${JSON.stringify(v)}`);
    await sleep(200);
  }
}
/** Names and modification times of the action's folder: opening and selecting write nothing there. */
const snapshot = (dir: string) => readdirSync(dir).map((f) => `${f}:${statSync(path.join(dir, f)).mtimeMs}`).sort();
const readJson = async (file: string) => JSON.parse(await readFile(file, "utf8"));
const lastSessionConfig = () =>
  path.join(w.dataDir, "workspace", (JSON.parse(readFileSync(path.join(w.dataDir, "workspace", "fake-agent-args.json"), "utf8")) as string[]).at(-1)!.replace(/^\/workspace\//, ""));
async function setPrivate(isPrivate: boolean): Promise<void> {
  const s = await state(m);
  const e = s.spaces.find((x) => x.id === s.windows[0]!.activeSpace)!;
  if (e.private !== isPrivate) await dispatch(m, { type: "updateSpace", id: e.id, name: e.name, icon: e.icon, private: isPrivate, profile: e.profile } as Action);
}

/** Opens the action's builder from its page (« Voir le workflow »), once the kernel serves the actions. */
async function openActionBuilder(id: string): Promise<void> {
  await openAction(m, id, NAME);
  await click(m, tid("show-workflow"));
  await visible(tid("builder"));
}

beforeAll(async () => {
  // A fake Ollama without Gemma (the fallback layout) nothing leaves for a real one.
  ollama = await listen((_req, res) => void res.writeHead(200, { "Content-Type": "application/json" }).end('{"models":[]}'));
  w = await launchRessac({ height: 1400, env: { RESSAC_OLLAMA_URL: ollama.url } });
  m = w.marionette;
  q = uiQueries(m);
  await m.setContext("chrome");
  await waitReady(m);
  await waitKernel(m);
}, 60_000);
afterAll(async () => {
  expect(await missingApi(m)).toEqual([]);
  await w?.close();
  await ollama?.close();
});

describe("the builder of an action", () => {
  it("▶ Lancer of an account action without grant: the grant card, then the run", { timeout: 90_000 }, async () => {
    await writeRunnableAction(w.dataDir, "courrier-b", { name: "Courrier", account: ["127.0.0.1"], code: `export default async () => ({ messages: [{ sujet: "Bonjour" }] });` });
    // Straight to the builder: the action page would ask for the grant itself.
    const s = await state(m);
    await dispatch(m, { type: "openTab", windowId: s.windows[0]!.id, url: "ressac://workflow/action/courrier-b", activate: true });
    await visible(tid("builder"));
    await waitUi(m, "return !doc.querySelector(arguments[0])?.disabled;", [tid("launch")], 30_000);
    await click(m, tid("launch"));
    const card = tid("grant-card");
    await q.waitText(`${card} :is(h1, h2, h3, h4)`, "Autoriser l'action « Courrier » à lire avec votre compte");
    // Nothing runs until the grant; « Annuler » launches nothing.
    await click(m, `${card} button`, { text: "Annuler" });
    await q.waitCount(card, 0);
    expect(await runsOnDisk(w.dataDir, "courrier-b")).toEqual([]);
    await click(m, tid("launch"));
    await click(m, `${card} button`, { text: "Autoriser" });
    await q.waitCount(card, 0);
    await poll(() => runsOnDisk(w.dataDir, "courrier-b"), (l) => l.length === 1, "one run after the grant");
  });

  // constructeur.spec.ts:1560
  it("opening an action's workflow from its page: the Action panel with input and instruction", { timeout: 60_000 }, async () => {
    await writeGitlab("gitlab-a");
    const before = snapshot(actionDir("gitlab-a"));
    await openActionBuilder("gitlab-a");
    await waitUi(m, "return [...doc.querySelectorAll('[data-testid^=\"tab-\"]')].filter((e) => e.textContent.includes(arguments[0])).length === 1;", [`Workflow — ${NAME}`]);
    await q.waitText(`${tid("builder")} h1`, NAME);
    await visible(tid("node-lire"));
    await q.waitText(tid("save-status"), "Enregistré");
    // Nothing selected: the Action panel (read only) instead of the widget's.
    const panel = tid("action-panel");
    await visible(panel);
    expect(await q.count(tid("widget-panel"))).toBe(0);
    expect(await q.text(`${panel} ${tid("action-account")}`)).toBe("aucun");
    expect(await q.text(`${panel} ${tid("action-public")}`)).toBe("gitlab.com");
    expect(await q.text(`${panel} ${tid("action-input")}`)).toBe("Projet");
    expect(await q.text(`${panel} ${tid("action-layout")}`)).toBe(GITLAB_INSTRUCTION);
    expect(await q.text(panel)).toContain("Durée maximale : 5 min");
    expect(await q.text(tid("preview-button"))).toBe("Aperçu de la page");
    // An action without web access: the palette says so for an action (action.json), not for a widget.
    const search = tid("palette-web.search");
    expect(await inUi(m, "return doc.querySelector(arguments[0]).disabled;", [search])).toBe(true);
    expect(await inUi(m, "return doc.querySelector(arguments[0]).title;", [search])).toBe(
      'L\'action doit déclarer "web": true dans ses sources (action.json) : demandez-le à l\'agent.',
    );
    // The agent knows it is the action's workflow, and the block chosen.
    // The window's agent session, its panel opened (the fake agent notes its arguments once started).
    await agentPanelReady(m);
    // Closed again, as before the panel stopped opening on its own: the canvas gets its full width back.
    await dispatch(m, { type: "toggleAgentPanel", windowId: (await state(m)).windows[0]!.id });
    await poll(() => existsSync(path.join(w.dataDir, "workspace", "fake-agent-args.json")), (v) => v, "the agent session", 20_000);
    const open = async () => (await callMcpTool(path.join(w.dataDir, "workspace"), "open_workflow", {}, lastSessionConfig())).text;
    await poll(open, (t) => t === '{"action":"gitlab-a","block":null}', "open_workflow", 20_000);
    await click(m, tid("node-lire"));
    await poll(open, (t) => t === '{"action":"gitlab-a","block":"lire"}', "open_workflow", 20_000);
    // Opening and selecting write nothing in the action's folder.
    expect(snapshot(actionDir("gitlab-a"))).toEqual(before);
  });

  // constructeur.spec.ts:1598
  it("▶ Lancer asks for the input, then the run shows in the list", { timeout: 120_000 }, async () => {
    await writeGitlab("gitlab-b");
    await openActionBuilder("gitlab-b");
    await q.waitContains(tid("builder"), "Aucune exécution pour l'instant.");
    await click(m, tid("launch"));
    const ask = tid("input-request");
    await visible(ask);
    expect(await q.text(ask)).toContain("Projet");
    // Empty input: nothing is launched.
    expect(await inUi(m, "return doc.querySelector(arguments[0]).disabled;", [tid("confirm-launch")])).toBe(true);
    // Escape closes the request without launching anything.
    await waitUi(m, "return doc.activeElement === doc.querySelector(arguments[0]);", [tid("launch-input")]);
    await pressKeys(m, "Escape");
    await q.waitCount(ask, 0);
    expect(await runsOnDisk(w.dataDir, "gitlab-b")).toEqual([]);
    await click(m, tid("launch"));
    await waitUi(m, "return doc.activeElement === doc.querySelector(arguments[0]);", [tid("launch-input")]);
    await inUi(m, `const f = doc.querySelector(arguments[0]); f.value = "ressac"; f.dispatchEvent(new ui.Event("input", { bubbles: true }));`, [tid("launch-input")]);
    await pressKeys(m, "Enter");
    await q.waitCount(ask, 0);
    const [file] = await poll(() => runsOnDisk(w.dataDir, "gitlab-b"), (l) => l.length === 1, "one run");
    const id = file!.replace(/\.json$/, "");
    const button = tid(`execution-${id}`);
    await visible(button);
    await waitUi(m, "return doc.querySelector(arguments[0]).getAttribute('aria-pressed') === 'true';", [button], 30_000);
    expect(await q.text(button)).toContain("Manuelle");
    await q.waitText(tid("pill-lire"), "1");
    expect(await readJson(path.join(actionsDataDir(w.dataDir), "gitlab-b", "runs", file!))).toMatchObject({ trigger: "manual", input: "ressac", status: "succeeded" });
    // The preview shows this run's page (the agent's components are never loaded there).
    await click(m, tid("preview-button"));
    await q.waitContains(tid("action-preview"), "ticket-ressac-un", 30_000);
  });

  // constructeur.spec.ts:1637
  it("replaying from a block: the preview shows a page, the action page's last result does not change", { timeout: 150_000 }, async () => {
    await writeGitlab("gitlab-c", "un");
    await openActionBuilder("gitlab-c");
    // A real run, launched from the page (its input: « ressac »). Not awaited in the script: a run may outlast its timeout.
    await inUi(m, "void ui.ressac.actions.launch('gitlab-c', 'ressac');");
    const [file] = await poll(() => runsOnDisk(w.dataDir, "gitlab-c"), (l) => l.length === 1, "the real run");
    const origin = file!.replace(/\.json$/, "");
    const run = await poll(() => readJson(path.join(actionsDataDir(w.dataDir), "gitlab-c", "runs", file!)), (e) => e.status !== "running", "its end", 60_000);
    expect(run.status).toBe("succeeded");
    await waitUi(m, "return doc.querySelector(arguments[0])?.getAttribute('aria-pressed') === 'true';", [tid(`execution-${origin}`)], 30_000);
    // The code changes: the trial shows it, the real run does not.
    // The new code needs its own approval before it reads (the action's card): given here as the user would.
    await writeGitlab("gitlab-c", "deux");
    await click(m, tid("node-lire"));
    await waitUi(m, "return doc.querySelector(arguments[0])?.disabled === false;", [tid("replay")]);
    await click(m, tid("replay"));
    const trials = () => runsOnDisk(w.dataDir, "gitlab-c").then((l) => l.filter((f) => f.includes("-attempt")));
    const [trialFile] = await poll(trials, (l) => l.length === 1, "one trial");
    const trial = trialFile!.replace(/\.json$/, "");
    const button = tid(`execution-${trial}`);
    await q.waitContains(button, "essai", 30_000);
    await waitUi(m, "return doc.querySelector(arguments[0]).getAttribute('aria-pressed') === 'true';", [button], 30_000);
    expect(await q.count(tid("replay-refusal"))).toBe(0);
    await click(m, tid("preview-button"));
    const preview = tid("action-preview");
    await visible(`${preview} ${tid("page-render")}`);
    // The trial takes the original run's input.
    await q.waitContains(preview, "ticket-ressac-deux", 30_000);
    // Choosing the real run: the preview shows its page.
    await click(m, tid(`execution-${origin}`));
    await q.waitContains(preview, "ticket-ressac-un", 30_000);
    // The action's last result stays the real run: its page does not show the trial.
    expect(await inUi(m, "return ui.ressac.actions.page('gitlab-c', null).then((p) => p?.run);")).toBe(origin);
    await openAction(m, "gitlab-c", NAME);
    await q.waitContains(`${tid("page-action")} ${tid("page-render")}`, "ticket-ressac-un", 30_000);
    expect(await q.text(tid("page-action"))).not.toContain("ticket-ressac-deux");
  });

  it("an action's builder tab in a private space shows ACTIONS_IN_PRIVATE_SPACE", { timeout: 60_000 }, async () => {
    await writeGitlab("gitlab-d");
    await openActionBuilder("gitlab-d");
    await setPrivate(true);
    try {
      await q.waitText(tid("action-private-space"), "Les actions ne sont pas disponibles dans un espace privé");
      expect(await q.count(tid("builder"))).toBe(0);
      // The API refuses too, with the same shapes, and writes nothing.
      const before = snapshot(actionDir("gitlab-d"));
      const target = { type: "action", id: "gitlab-d" };
      expect(
        await inUi(
          m,
          `const c = arguments[0], wf = ui.ressac.workflow;
          return Promise.all([wf.read(c), wf.save(c, { version: 1, blocks: [], links: [] }), wf.readCode(c, "lire.mjs"), wf.saveCode(c, "lire.mjs", "x"),
            wf.replay(c, "2026-10-31T08-00-00-000Z", "lire"), wf.run(c, "ressac")]).then((r) => JSON.parse(JSON.stringify(r)));`,
          [target],
        ),
      ).toEqual([
        null,
        { ok: false, error: "Les actions ne sont pas disponibles dans un espace privé", warnings: [] },
        { error: "Les actions ne sont pas disponibles dans un espace privé" },
        { ok: false, error: "Les actions ne sont pas disponibles dans un espace privé" },
        { ok: false, error: "Les actions ne sont pas disponibles dans un espace privé" },
        { error: "Les actions ne sont pas disponibles dans un espace privé" },
      ]);
      await sleep(500);
      expect(snapshot(actionDir("gitlab-d"))).toEqual(before);
      expect(await runsOnDisk(w.dataDir, "gitlab-d")).toEqual([]);
    } finally {
      await setPrivate(false);
    }
    // Public again: the builder comes back.
    await visible(tid("builder"));
  });
});
