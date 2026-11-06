import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Action } from "../../navigateur/src/commun/api";
import { actionsDataDir, EXECUTION, runsOnDisk, startActionServers, tid, uiQueries, waitNoyau, writeResult, writeRunnableAction } from "./actions";
import { dispatch, state, waitReady } from "./firefox";
import { launchWebAiOs, type LaunchedWebAiOs } from "./launch";
import type { Marionette } from "./marionette";
import { click, inUi, missingApi, pressKeys, waitUi } from "./ui";

// The « Actions » page of the sidebar (Electron's actions.spec.ts:995-1150, ported): lists, launches, opens the
// builder, deletes, removes the accord. The actions are written before the launch, on one data folder for the file.

const TICKETS_NOM = "Mes tickets GitLab à traiter";
const HIER = "2026-10-30T08:00:00.000Z";

let servers: Awaited<ReturnType<typeof startActionServers>>;
let w: LaunchedWebAiOs;
let m: Marionette;
let q: ReturnType<typeof uiQueries>;
const kept: string[] = [];

const visible = (selector: string, ms = 30_000) => waitUi(m, "const e = doc.querySelector(arguments[0]); return !!e && e.getBoundingClientRect().height > 0;", [selector], ms);
async function waitRuns(id: string, n: number): Promise<void> {
  for (const deadline = Date.now() + 60_000; (await runsOnDisk(w.dataDir, id)).length !== n; await new Promise((r) => setTimeout(r, 200)))
    if (Date.now() > deadline) throw new Error(`${id}: expected ${n} runs, got ${(await runsOnDisk(w.dataDir, id)).length}`);
}
async function setPrivate(prive: boolean): Promise<void> {
  const s = await state(m);
  const e = s.espaces.find((x) => x.id === s.fenetres[0]!.espaceActif)!;
  if (e.prive !== prive) await dispatch(m, { type: "reglerEspace", id: e.id, nom: e.nom, icone: e.icone, prive, profil: e.profil } as Action);
}
/** Electron's ouvrirPageActions. */
async function openActionsPage(): Promise<void> {
  await click(m, tid("bouton-actions"));
  await visible(tid("page-actions"));
}
/** The window's tabs closed, the space public again. */
async function fresh(): Promise<void> {
  await setPrivate(false);
  for (const id of Object.keys((await state(m)).onglets)) await dispatch(m, { type: "fermerOnglet", id } as Action);
}
/** Electron's ecrireDeuxActions: « Tickets » (keywords, last result) and « Leboncoin » (input, never launched). */
async function writeTwoActions(d: string): Promise<void> {
  await writeRunnableAction(d, "tickets", { nom: TICKETS_NOM, motsCles: ["gitlab", "tickets"], code: "export default async () => [{ page: { titre: 'Ticket 1' } }];" });
  await writeResult(d, "tickets", EXECUTION, HIER, "Ticket 1");
  await writeRunnableAction(d, "leboncoin", { nom: "Leboncoin", saisie: "Recherche", code: "export default async () => [{ page: { titre: 'Annonce' } }];" });
}
async function launch(prepare: (dataDir: string) => Promise<void>): Promise<void> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "webaios-data-"));
  kept.push(dataDir);
  await prepare(dataDir);
  // A fake Gemma and Kev: no layout request leaves for a real Ollama.
  w = await launchWebAiOs({ dataDir, env: { WEBAIOS_OLLAMA_URL: servers.ollama.url, WEBAIOS_KEV_URL: servers.kev.url, WEBAIOS_TEST_ADRESSES_LOCALES: "1" } });
  m = w.marionette;
  q = uiQueries(m);
  await m.setContext("chrome");
  await waitReady(m);
  await waitNoyau(m);
}
async function close(): Promise<void> {
  expect(await missingApi(m)).toEqual([]);
  await w?.close();
}
beforeAll(async () => (servers = await startActionServers()));
beforeEach(() => servers.reset());
afterAll(async () => {
  await servers?.close();
  for (const d of kept) await rm(d, { recursive: true, force: true });
});

describe("the Actions page without actions", () => {
  beforeAll(() => launch(async () => {}), 60_000);
  afterAll(close);

  // actions.spec.ts:1140
  it("no action: the invitation; private space: ACTIONS_EN_ESPACE_PRIVE", async () => {
    await openActionsPage();
    await q.waitContains(tid("page-actions"), "Aucune action. Demande à l'agent de t'en créer une.");
    await setPrivate(true);
    await q.waitText(tid("action-espace-prive"), "Les actions ne sont pas disponibles dans un espace privé");
    expect(await q.count(tid("page-actions"))).toBe(0);
  });
});

describe("the Actions page", () => {
  beforeAll(
    () =>
      launch(async (d) => {
        await writeTwoActions(d);
        // An action that reads with the account, its accord given and a result (actions.spec.ts:1063, :1097).
        for (const id of ["compte", "accord"]) {
          await writeRunnableAction(d, id, { nom: "Avec compte", compte: ["127.0.0.1"], code: "export default async () => [{ page: { titre: 'x' } }];" });
          await writeResult(d, id, EXECUTION, HIER, "Secret");
        }
        const accord = { domaines: ["127.0.0.1"], publiques: [], profil: "defaut" };
        await writeFile(path.join(actionsDataDir(d), "accords.json"), JSON.stringify({ compte: accord, accord }));
        // actions.spec.ts:1122
        await mkdir(path.join(d, "espace", "actions", "cassee"), { recursive: true });
        await writeFile(path.join(d, "espace", "actions", "cassee", "action.json"), "{ pas du json");
      }),
    60_000,
  );
  afterEach(fresh);
  afterAll(close);

  // actions.spec.ts:995
  it("the page lists two actions with their keywords and last result", async () => {
    await openActionsPage();
    await q.waitContains(tid("ligne-action-tickets"), TICKETS_NOM);
    expect(await q.text(tid("mots-cles-tickets"))).toBe("gitlab, tickets");
    expect(await q.text(tid("dernier-tickets"))).toContain("Réussie");
    expect(await q.text(tid("ligne-action-leboncoin"))).toContain("Leboncoin");
    expect(await q.text(tid("dernier-leboncoin"))).toContain("Jamais lancée");
    // No accord: no « Retirer l'accord ».
    expect(await q.count(tid("retirer-accord-tickets"))).toBe(0);
  });

  // actions.spec.ts:1016
  it("Lancer opens the action's page; an action with input asks for it inline first", { timeout: 120_000 }, async () => {
    await openActionsPage();
    await click(m, tid("lancer-tickets"));
    await visible(tid("page-action"));
    await waitRuns("tickets", 2);
    await openActionsPage();
    await click(m, tid("lancer-leboncoin"));
    const field = tid("saisie-leboncoin");
    await visible(field);
    expect(await q.count(tid("page-action"))).toBe(0);
    // Empty input: nothing launched, the field stays with its message.
    await inUi(m, "doc.querySelector(arguments[0]).focus();", [field]);
    await pressKeys(m, "Enter");
    await q.waitText(tid("refus-actions"), "Saisie requise : Recherche");
    await visible(field);
    expect(await q.count(tid("page-action"))).toBe(0);
    expect(await runsOnDisk(w.dataDir, "leboncoin")).toHaveLength(0);
    await inUi(m, `const f = doc.querySelector(arguments[0]); f.value = "vélo"; f.dispatchEvent(new ui.Event("input", { bubbles: true }));`, [field]);
    await pressKeys(m, "Enter");
    await visible(tid("page-action"));
    await waitRuns("leboncoin", 1);
  });

  // actions.spec.ts:1048
  it("« Voir le workflow » opens the action's builder", async () => {
    await openActionsPage();
    await click(m, tid("voir-workflow-tickets"));
    await waitUi(m, "return !!doc.querySelector('[data-testid^=\"onglet-\"]') && [...doc.querySelectorAll('[data-testid^=\"onglet-\"]')].some((e) => e.textContent.includes(arguments[0]));", [
      `Workflow — ${TICKETS_NOM}`,
    ]);
    expect(Object.values((await state(m)).onglets).filter((o) => o.url === "webaios://workflow/action/tickets")).toHaveLength(1);
    await visible(tid("constructeur"));
  });

  // actions.spec.ts:1063
  it("Supprimer: the folder goes to actions/.corbeille, the accord and results are erased, the line goes", async () => {
    await openActionsPage();
    await visible(tid("retirer-accord-compte"));
    await click(m, tid("supprimer-compte"));
    await q.waitContains(tid("confirmation-suppression-action"), "Avec compte");
    // The confirmation covers the whole window, its drag regions included (the last matching rule gives the value).
    for (const id of ["voile-suppression-action", "confirmation-suppression-action"]) {
      const dragging = await inUi<string>(
        m,
        `const el = doc.querySelector(arguments[0]);
        let value = "default";
        for (const sheet of doc.styleSheets) for (const r of sheet.cssRules) {
          const v = /-moz-window-dragging: ([a-z-]+)/.exec(r.cssText)?.[1];
          if (v && r.selectorText && el.matches(r.selectorText)) value = v;
        }
        return value;`,
        [tid(id)],
      );
      expect(dragging, id).toBe("no-drag");
    }
    // Annuler deletes nothing.
    await click(m, tid("annuler-suppression-action"));
    await visible(tid("ligne-action-compte"));
    await click(m, tid("supprimer-compte"));
    await click(m, tid("confirmer-suppression-action"));
    await q.waitCount(tid("ligne-action-compte"), 0);
    expect((await readdir(path.join(w.dataDir, "espace", "actions", ".corbeille"))).some((f) => f.startsWith("compte-"))).toBe(true);
    expect(existsSync(path.join(w.dataDir, "espace", "actions", "compte"))).toBe(false);
    expect(existsSync(path.join(actionsDataDir(w.dataDir), "compte"))).toBe(false);
    expect(Object.keys(JSON.parse(await readFile(path.join(actionsDataDir(w.dataDir), "accords.json"), "utf8")))).not.toContain("compte");
    await visible(tid("ligne-action-tickets"));
  });

  // actions.spec.ts:1097
  it("removing the accord: the button goes, results erased", async () => {
    const result = path.join(actionsDataDir(w.dataDir), "accord", "resultats", `${EXECUTION}.json`);
    await openActionsPage();
    await click(m, tid("retirer-accord-accord"));
    // Annuler keeps the accord and the results.
    await click(m, tid("annuler-suppression-action"));
    await visible(tid("retirer-accord-accord"));
    expect(existsSync(result)).toBe(true);
    await click(m, tid("retirer-accord-accord"));
    await click(m, tid("confirmer-suppression-action"));
    await q.waitCount(tid("retirer-accord-accord"), 0);
    await q.waitContains(tid("dernier-accord"), "Jamais lancée");
    expect(existsSync(result)).toBe(false);
  });

  // actions.spec.ts:1122
  it("a broken action.json shows its error", async () => {
    await openActionsPage();
    await q.waitContains(tid("erreur-cassee"), "action.json");
    expect(await q.count(tid("lancer-cassee"))).toBe(0);
    await visible(tid("ligne-action-tickets"));
  });
});
