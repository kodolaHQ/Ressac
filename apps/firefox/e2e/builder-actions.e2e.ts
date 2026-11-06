import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Action } from "../../navigateur/src/commun/api";
import { appelerOutil } from "../test/mcp";
import { actionsDataDir, listen, openAction, runsOnDisk, tid, uiQueries, waitNoyau, writeAction, type TestServer } from "./actions";
import { dispatch, state, waitReady } from "./firefox";
import { launchWebAiOs, type LaunchedWebAiOs } from "./launch";
import type { Marionette } from "./marionette";
import { click, inUi, missingApi, pressKeys, waitUi } from "./ui";

// The workflow builder opened on an action (webaios://workflow/action/<id>), Electron's constructeur.spec.ts:1514-1677
// ported: the Action panel, ▶ Lancer with the input, a replay whose page shows in the preview without becoming the last
// result. Gemma absent: the fallback layout.

const CONSIGNE_GITLAB = "Un tableau des tickets, les plus urgents d'abord";
const NOM = "Tickets GitLab";
const codeGitlab = (marque: string) => `export default async (_e, w) => [{ titre: "ticket-" + w.saisie + "-${marque}" }];`;
/** An action with an input: a `code` block that gives the input (and `marque`), then the output to the page. */
const writeGitlab = (id: string, marque = "un") =>
  writeAction(w.dataDir, id, {
    nom: NOM,
    saisie: { libelle: "Projet" },
    sources: { publiques: ["gitlab.com"] },
    miseEnPage: CONSIGNE_GITLAB,
    dureeMaxMinutes: 5,
    workflow: {
      version: 1,
      blocs: [
        { id: "lire", type: "code", parametres: { source: "lire.mjs" } },
        { id: "sortie", type: "sortie", parametres: { vers: "page" } },
      ],
      liens: [{ de: "lire", vers: "sortie" }],
    },
    fichiers: { "lire.mjs": codeGitlab(marque) },
  });
const actionDir = (id: string) => path.join(w.dataDir, "espace", "actions", id);

let w: LaunchedWebAiOs;
let m: Marionette;
let q: ReturnType<typeof uiQueries>;
let ollama: TestServer;
let kev: TestServer;

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
  path.join(w.dataDir, "espace", (JSON.parse(readFileSync(path.join(w.dataDir, "espace", "faux-agent-args.json"), "utf8")) as string[]).at(-1)!.replace(/^\/workspace\//, ""));
async function setPrivate(prive: boolean): Promise<void> {
  const s = await state(m);
  const e = s.espaces.find((x) => x.id === s.fenetres[0]!.espaceActif)!;
  if (e.prive !== prive) await dispatch(m, { type: "reglerEspace", id: e.id, nom: e.nom, icone: e.icone, prive, profil: e.profil } as Action);
}

/** Opens the action's builder from its page (« Voir le workflow »), once the noyau serves the actions (Electron's ouvrirConstructeurAction). */
async function openActionBuilder(id: string): Promise<void> {
  await openAction(m, id, NOM);
  await click(m, tid("voir-workflow"));
  await visible(tid("constructeur"));
}

beforeAll(async () => {
  // A fake Ollama without Gemma (the fallback layout) and a fake Kev: nothing leaves for a real one.
  ollama = await listen((_req, res) => void res.writeHead(200, { "Content-Type": "application/json" }).end('{"models":[]}'));
  kev = await listen((_req, res) => void res.writeHead(200, { "Content-Type": "application/json" }).end('{"data":[]}'));
  w = await launchWebAiOs({ height: 1400, env: { WEBAIOS_OLLAMA_URL: ollama.url, WEBAIOS_KEV_URL: kev.url } });
  m = w.marionette;
  q = uiQueries(m);
  await m.setContext("chrome");
  await waitReady(m);
  await waitNoyau(m);
}, 60_000);
afterAll(async () => {
  expect(await missingApi(m)).toEqual([]);
  await w?.close();
  await ollama?.close();
  await kev?.close();
});

describe("the builder of an action", () => {
  // constructeur.spec.ts:1560
  it("opening an action's workflow from its page: the Action panel with input and instruction", { timeout: 60_000 }, async () => {
    await writeGitlab("gitlab-a");
    const before = snapshot(actionDir("gitlab-a"));
    await openActionBuilder("gitlab-a");
    await waitUi(m, "return [...doc.querySelectorAll('[data-testid^=\"onglet-\"]')].filter((e) => e.textContent.includes(arguments[0])).length === 1;", [`Workflow — ${NOM}`]);
    await q.waitText(`${tid("constructeur")} h1`, NOM);
    await visible(tid("noeud-lire"));
    await q.waitText(tid("etat-enregistrement"), "Enregistré");
    // Nothing selected: the Action panel (read only) instead of the widget's.
    const panel = tid("panneau-action");
    await visible(panel);
    expect(await q.count(tid("panneau-widget"))).toBe(0);
    expect(await q.text(`${panel} ${tid("action-compte")}`)).toBe("aucun");
    expect(await q.text(`${panel} ${tid("action-publiques")}`)).toBe("gitlab.com");
    expect(await q.text(`${panel} ${tid("action-saisie")}`)).toBe("Projet");
    expect(await q.text(`${panel} ${tid("action-mise-en-page")}`)).toBe(CONSIGNE_GITLAB);
    expect(await q.text(panel)).toContain("Durée maximale : 5 min");
    expect(await q.text(tid("bouton-apercu"))).toBe("Aperçu de la page");
    // An action without web access: the palette says so for an action (action.json), not for a widget.
    const search = tid("palette-web.chercher");
    expect(await inUi(m, "return doc.querySelector(arguments[0]).disabled;", [search])).toBe(true);
    expect(await inUi(m, "return doc.querySelector(arguments[0]).title;", [search])).toBe(
      'L\'action doit déclarer "web": true dans ses sources (action.json) : demande-le à l\'agent.',
    );
    // The agent knows it is the action's workflow, and the block chosen.
    // The window's agent session (the fake agent notes its arguments once started).
    await poll(() => existsSync(path.join(w.dataDir, "espace", "faux-agent-args.json")), (v) => v, "the agent session", 20_000);
    const open = async () => (await appelerOutil(path.join(w.dataDir, "espace"), "workflow_ouvert", {}, lastSessionConfig())).texte;
    await poll(open, (t) => t === '{"action":"gitlab-a","bloc":null}', "workflow_ouvert", 20_000);
    await click(m, tid("noeud-lire"));
    await poll(open, (t) => t === '{"action":"gitlab-a","bloc":"lire"}', "workflow_ouvert", 20_000);
    // Opening and selecting write nothing in the action's folder.
    expect(snapshot(actionDir("gitlab-a"))).toEqual(before);
  });

  // constructeur.spec.ts:1598
  it("▶ Lancer asks for the input, then the run shows in the list", { timeout: 120_000 }, async () => {
    await writeGitlab("gitlab-b");
    await openActionBuilder("gitlab-b");
    await q.waitContains(tid("constructeur"), "Aucune exécution pour l'instant.");
    await click(m, tid("lancer"));
    const ask = tid("demande-saisie");
    await visible(ask);
    expect(await q.text(ask)).toContain("Projet");
    // Empty input: nothing is launched.
    expect(await inUi(m, "return doc.querySelector(arguments[0]).disabled;", [tid("confirmer-lancer")])).toBe(true);
    // Escape closes the request without launching anything.
    await waitUi(m, "return doc.activeElement === doc.querySelector(arguments[0]);", [tid("saisie-lancer")]);
    await pressKeys(m, "Escape");
    await q.waitCount(ask, 0);
    expect(await runsOnDisk(w.dataDir, "gitlab-b")).toEqual([]);
    await click(m, tid("lancer"));
    await waitUi(m, "return doc.activeElement === doc.querySelector(arguments[0]);", [tid("saisie-lancer")]);
    await inUi(m, `const f = doc.querySelector(arguments[0]); f.value = "webaios"; f.dispatchEvent(new ui.Event("input", { bubbles: true }));`, [tid("saisie-lancer")]);
    await pressKeys(m, "Enter");
    await q.waitCount(ask, 0);
    const [file] = await poll(() => runsOnDisk(w.dataDir, "gitlab-b"), (l) => l.length === 1, "one run");
    const id = file!.replace(/\.json$/, "");
    const button = tid(`execution-${id}`);
    await visible(button);
    await waitUi(m, "return doc.querySelector(arguments[0]).getAttribute('aria-pressed') === 'true';", [button], 30_000);
    expect(await q.text(button)).toContain("Manuelle");
    await q.waitText(tid("pastille-lire"), "1");
    expect(await readJson(path.join(actionsDataDir(w.dataDir), "gitlab-b", "executions", file!))).toMatchObject({ declencheur: "manuelle", saisie: "webaios", statut: "reussie" });
    // The preview shows this run's page (the agent's components are never loaded there).
    await click(m, tid("bouton-apercu"));
    await q.waitContains(tid("apercu-action"), "ticket-webaios-un", 30_000);
  });

  // constructeur.spec.ts:1637
  it("replaying from a block: the preview shows a page, the action page's last result does not change", { timeout: 150_000 }, async () => {
    await writeGitlab("gitlab-c", "un");
    await openActionBuilder("gitlab-c");
    // A real run, launched from the page (its input: « webaios »). Not awaited in the script: a run may outlast its timeout.
    await inUi(m, "void ui.webaios.actions.lancer('gitlab-c', 'webaios');");
    const [file] = await poll(() => runsOnDisk(w.dataDir, "gitlab-c"), (l) => l.length === 1, "the real run");
    const origin = file!.replace(/\.json$/, "");
    const run = await poll(() => readJson(path.join(actionsDataDir(w.dataDir), "gitlab-c", "executions", file!)), (e) => e.statut !== "en-cours", "its end", 60_000);
    expect(run.statut).toBe("reussie");
    await waitUi(m, "return doc.querySelector(arguments[0])?.getAttribute('aria-pressed') === 'true';", [tid(`execution-${origin}`)], 30_000);
    // The code changes: the trial shows it, the real run does not.
    await writeFile(path.join(actionDir("gitlab-c"), "lire.mjs"), codeGitlab("deux"));
    await click(m, tid("noeud-lire"));
    await waitUi(m, "return doc.querySelector(arguments[0])?.disabled === false;", [tid("rejouer")]);
    await click(m, tid("rejouer"));
    const trials = () => runsOnDisk(w.dataDir, "gitlab-c").then((l) => l.filter((f) => f.includes("-essai")));
    const [trialFile] = await poll(trials, (l) => l.length === 1, "one trial");
    const trial = trialFile!.replace(/\.json$/, "");
    const button = tid(`execution-${trial}`);
    await q.waitContains(button, "essai", 30_000);
    await waitUi(m, "return doc.querySelector(arguments[0]).getAttribute('aria-pressed') === 'true';", [button], 30_000);
    expect(await q.count(tid("refus-rejeu"))).toBe(0);
    await click(m, tid("bouton-apercu"));
    const preview = tid("apercu-action");
    await visible(`${preview} ${tid("rendu-page")}`);
    // The trial takes the original run's input.
    await q.waitContains(preview, "ticket-webaios-deux", 30_000);
    // Choosing the real run: the preview shows its page.
    await click(m, tid(`execution-${origin}`));
    await q.waitContains(preview, "ticket-webaios-un", 30_000);
    // The action's last result stays the real run: its page does not show the trial.
    expect(await inUi(m, "return ui.webaios.actions.page('gitlab-c', null).then((p) => p?.execution);")).toBe(origin);
    await openAction(m, "gitlab-c", NOM);
    await q.waitContains(`${tid("page-action")} ${tid("rendu-page")}`, "ticket-webaios-un", 30_000);
    expect(await q.text(tid("page-action"))).not.toContain("ticket-webaios-deux");
  });

  it("an action's builder tab in a private space shows ACTIONS_EN_ESPACE_PRIVE", { timeout: 60_000 }, async () => {
    await writeGitlab("gitlab-d");
    await openActionBuilder("gitlab-d");
    await setPrivate(true);
    try {
      await q.waitText(tid("action-espace-prive"), "Les actions ne sont pas disponibles dans un espace privé");
      expect(await q.count(tid("constructeur"))).toBe(0);
      // The API refuses too, with Electron's shapes, and writes nothing.
      const before = snapshot(actionDir("gitlab-d"));
      const cible = { type: "action", id: "gitlab-d" };
      expect(
        await inUi(
          m,
          `const c = arguments[0], wf = ui.webaios.workflow;
          return Promise.all([wf.lire(c), wf.enregistrer(c, { version: 1, blocs: [], liens: [] }), wf.lireCode(c, "lire.mjs"), wf.enregistrerCode(c, "lire.mjs", "x"),
            wf.rejouer(c, "2026-10-31T08-00-00-000Z", "lire"), wf.lancer(c, "webaios")]).then((r) => JSON.parse(JSON.stringify(r)));`,
          [cible],
        ),
      ).toEqual([
        null,
        { ok: false, erreur: "Les actions ne sont pas disponibles dans un espace privé", avertissements: [] },
        { erreur: "Les actions ne sont pas disponibles dans un espace privé" },
        { ok: false, erreur: "Les actions ne sont pas disponibles dans un espace privé" },
        { ok: false, erreur: "Les actions ne sont pas disponibles dans un espace privé" },
        { erreur: "Les actions ne sont pas disponibles dans un espace privé" },
      ]);
      await sleep(500);
      expect(snapshot(actionDir("gitlab-d"))).toEqual(before);
      expect(await runsOnDisk(w.dataDir, "gitlab-d")).toEqual([]);
    } finally {
      await setPrivate(false);
    }
    // Public again: the builder comes back.
    await visible(tid("constructeur"));
  });
});
