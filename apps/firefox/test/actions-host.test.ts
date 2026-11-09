import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  accorder,
  spacePaths,
  writeRun,
  writeResult,
  idExecution,
  lireAction,
  type ActionsNoyau,
  type SpacePaths,
  type ActionsState,
  type Execution,
  type ActionLaunch,
  type Noyau,
  type LaunchResult,
} from "../../../packages/kernel/src/index";
import { actionImageAllowed, createActionsHost, linkAllowed, MESSAGE_SANS_NOYAU, readShownActions, trashAction } from "../host/actions";
import { SchemaAccord, SchemaIdAction, ActionInputSchema } from "../shared/api";

const DEBUT = "2026-10-31T10:00:00.000Z";
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A temporary space with these actions (`action.json`), and the folder of their data outside the space. */
function space(declarations: Record<string, object>): { c: SpacePaths; dossierActions: string } {
  const root = mkdtempSync(join(tmpdir(), "webaios-actions-host-"));
  dirs.push(root);
  const c = spacePaths(join(root, "WebAiOs"));
  for (const [id, d] of Object.entries(declarations)) {
    mkdirSync(join(c.actions, id), { recursive: true });
    writeFileSync(join(c.actions, id, "action.json"), JSON.stringify(d));
  }
  return { c, dossierActions: join(root, "profil", "actions") };
}

/** A kept run of the action, with its results; gives its id. */
async function executer(dossierActions: string, id: string, results: unknown, debut = DEBUT): Promise<string> {
  const ex = idExecution(debut);
  const e: Execution = { version: 1, id: ex, proprietaire: { type: "action", id }, declencheur: "manuelle", debut, fin: debut, statut: "reussie", blocs: [] };
  await writeRun(join(dossierActions, id), e);
  await writeResult(dossierActions, id, { version: 1, execution: ex, saisie: null, resultats: results, plan: null, secours: true, vide: false });
  return ex;
}

describe("input schemas", () => {
  it("accept and refuse these ids, inputs and grants", () => {
    const accord = { id: "gitlab", profil: "defaut", compte: ["gitlab.com"], publiques: [] };
    const ok = (sc: { safeParse: (v: unknown) => { success: boolean } }, vs: unknown[]) => vs.map((v) => sc.safeParse(v).success);
    expect(ok(SchemaIdAction, ["gitlab", "a-1", "", "Git_Lab", "../x", "a".repeat(60), "a".repeat(61), 3, null])).toEqual([true, true, false, false, false, true, false, false, false]);
    expect(ok(ActionInputSchema, [null, "", "x".repeat(2000), "x".repeat(2001), 4, undefined])).toEqual([true, true, true, false, false, false]);
    expect(ok(SchemaAccord, [accord, { ...accord, extra: 1 }, { ...accord, id: "../x" }, { ...accord, profil: "" }, { ...accord, compte: [""] }, { ...accord, publiques: Array(101).fill("a.b") }, null])).toEqual([true, false, false, false, false, false, false]);
  });
});

describe("actionImageAllowed", () => {
  // actions.test.ts:116
  it("allows an https address present as is in the results of a run of an action without account", async () => {
    const { c, dossierActions } = space({ leboncoin: { nom: "Leboncoin", sources: { web: true } } });
    const image = "https://img.test/annonce/1.jpg?rule=ad-large";
    const ex = await executer(dossierActions, "leboncoin", { annonces: [{ titre: "Clio", photo: image }] });
    expect(await actionImageAllowed({ dossierActions, lireAction: (id) => lireAction(c, id) }, "leboncoin", ex, image)).toBe(true);
  });

  // actions.test.ts:202
  it("refuses an action that has an account grant, even if its declaration no longer has an account", async () => {
    const { c, dossierActions } = space({ reecrite: { nom: "Réécrite", sources: { web: true } } });
    const image = "https://img.test/a.jpg";
    const ex = await executer(dossierActions, "reecrite", { photo: image });
    await accorder(dossierActions, "reecrite", { domaines: ["gitlab.com"], publiques: [], profil: "defaut" });
    expect(await actionImageAllowed({ dossierActions, lireAction: (id) => lireAction(c, id) }, "reecrite", ex, image)).toBe(false);
  });
});

describe("pure helpers", () => {
  // actions.test.ts:285
  it("linkAllowed: only an openable http(s) address present as is in the run's results", async () => {
    const { dossierActions } = space({});
    const ex = await executer(dossierActions, "gitlab", { tickets: [{ url: "https://gitlab.com/a/-/issues/1", code: "javascript:alert(1)", local: "http://127.0.0.1:5280/" }] });
    expect(await linkAllowed(dossierActions, "gitlab", ex, "https://gitlab.com/a/-/issues/1")).toBe(true);
    for (const url of ["https://gitlab.com/a/-/issues/2", "javascript:alert(1)", "http://127.0.0.1:5280/", "https://tiers.test/?d=https://gitlab.com/a/-/issues/1"]) {
      expect(await linkAllowed(dossierActions, "gitlab", ex, url), url).toBe(false);
    }
    expect(await linkAllowed(dossierActions, "gitlab", idExecution("2026-10-31T12:00:00.000Z"), "https://gitlab.com/a/-/issues/1")).toBe(false);
    expect(await linkAllowed(dossierActions, "../gitlab", ex, "https://gitlab.com/a/-/issues/1")).toBe(false);
  });

  // actions.test.ts:296
  it("trashAction puts the folder in the trash (nothing is destroyed) and calls oublier", async () => {
    const { c } = space({ gitlab: { nom: "GitLab" } });
    const forgotten: string[] = [];
    await trashAction(c, "gitlab", async (id) => void forgotten.push(id));
    expect(existsSync(join(c.actions, "gitlab"))).toBe(false);
    const trash = readdirSync(join(c.actions, ".corbeille"));
    expect(trash).toHaveLength(1);
    expect(trash[0]).toMatch(/^gitlab-\d+$/);
    expect(readFileSync(join(c.actions, ".corbeille", trash[0]!, "action.json"), "utf8")).toContain("GitLab");
    expect(forgotten).toEqual(["gitlab"]);
    await expect(trashAction(c, "../x", async () => {})).rejects.toThrow();
  });

  // actions.test.ts:309
  it("readShownActions: declaration, grant, last result (not a trial), broken action flagged", async () => {
    const { c, dossierActions } = space({
      gitlab: { nom: "GitLab", description: "Mes tickets", motsCles: ["tickets"], sources: { compte: ["gitlab.com"] } },
      leboncoin: { nom: "Leboncoin", saisie: { libelle: "Recherche" }, sources: { web: true } },
    });
    mkdirSync(join(c.actions, "cassee"), { recursive: true });
    writeFileSync(join(c.actions, "cassee", "action.json"), "{");
    const ex = await executer(dossierActions, "leboncoin", { a: 1 });
    const list = await readShownActions(c, dossierActions);
    expect(list.map((a) => a.id)).toEqual(["cassee", "gitlab", "leboncoin"]);
    expect(list[0]).toMatchObject({ id: "cassee", nom: "cassee", motsCles: [], saisie: null, compte: [], accord: false, dernier: null });
    expect(list[0]!.erreur).toBeTruthy();
    expect(list[1]).toEqual({ id: "gitlab", nom: "GitLab", description: "Mes tickets", motsCles: ["tickets"], saisie: null, compte: ["gitlab.com"], publiques: [], accord: false, dernier: null });
    expect(list[2]).toEqual({ id: "leboncoin", nom: "Leboncoin", description: "", motsCles: [], saisie: { libelle: "Recherche" }, compte: [], publiques: [], accord: false, dernier: { execution: ex, debut: DEBUT, statut: "reussie" } });
  });
});

/** A fake kernel of the actions: notes the launches and stops. */
function fakeKernel(direct: ActionsState = { courantes: [], enAttente: [] }, issue: LaunchResult | Promise<LaunchResult> = { statut: "reussie", execution: "x" }) {
  const lances: { id: string; saisie?: string }[] = [];
  const stoppedList: string[] = [];
  /** Stops and grant removals, in order. */
  const calls: string[] = [];
  const actions = {
    lancer: (id: string, o: { saisie?: string }): ActionLaunch => {
      lances.push({ id, ...(o.saisie !== undefined ? { saisie: o.saisie } : {}) });
      return { deja: false, fin: Promise.resolve(issue) };
    },
    arreter: (id: string) => {
      stoppedList.push(id);
      calls.push(`arreter:${id}`);
    },
    direct: () => direct,
    page: async () => null,
    executions: async () => [],
    accorder: async () => {},
    refuserAccord: async (id: string) => void calls.push(`refuserAccord:${id}`),
  } as unknown as ActionsNoyau;
  return { lances, arretes: stoppedList, appels: calls, noyau: { actions } as unknown as Noyau };
}

function host(o: { direct?: ActionsState; issue?: LaunchResult | Promise<LaunchResult>; sansNoyau?: boolean } = {}) {
  const { c, dossierActions } = space({
    gitlab: { nom: "GitLab", sources: { compte: ["gitlab.com"] } },
    leboncoin: { nom: "Leboncoin", saisie: { libelle: "Recherche" }, sources: { web: true } },
  });
  const fake = fakeKernel(o.direct, o.issue);
  let changes = 0;
  let clock = 10_000;
  const create = (noyau: Noyau | null = fake.noyau) =>
    createActionsHost({ chemins: c, dossierActions, noyau: () => (o.sansNoyau ? null : noyau), surChange: () => void changes++, maintenant: () => clock });
  return { h: create(), creer: create, c, dossierActions, ...fake, changes: () => changes, avancer: (ms: number) => (clock += ms) };
}

describe("preparer", () => {
  // actions.test.ts:413
  it("reads without launching: running, waiting or missing input give lancer false", async () => {
    const { h, lances } = host();
    expect(await h.preparer("gitlab", null)).toEqual({ ok: true, nom: "GitLab", lancer: true });
    expect(await h.preparer("leboncoin", "clio lyon")).toEqual({ ok: true, nom: "Leboncoin", lancer: true });
    expect(await h.preparer("leboncoin", null)).toEqual({ ok: true, nom: "Leboncoin", lancer: false });
    expect(await h.preparer("leboncoin", "  ")).toEqual({ ok: true, nom: "Leboncoin", lancer: false });
    const courante = { action: "gitlab", debut: DEBUT, saisie: null, essai: false, etape: "workflow", blocs: {} } as unknown as ActionsState["courantes"][number];
    expect(await host({ direct: { courantes: [courante], enAttente: [] } }).h.preparer("gitlab", null)).toEqual({ ok: true, nom: "GitLab", lancer: false });
    expect(await host({ direct: { courantes: [], enAttente: [{ action: "gitlab", depuis: DEBUT }] } }).h.preparer("gitlab", null)).toMatchObject({ lancer: false });
    expect(lances).toEqual([]);
  });

  // actions.test.ts:423
  it("an unknown action or a missing kernel is refused", async () => {
    const { h } = host();
    expect(await h.preparer("inconnue", null)).toEqual({ ok: false, erreur: "Action inconnue" });
    expect(await h.preparer("../x", null)).toEqual({ ok: false, erreur: "Action inconnue" });
    expect(await host({ sansNoyau: true }).h.preparer("gitlab", null)).toEqual({ ok: false, erreur: MESSAGE_SANS_NOYAU });
  });
});

describe("lancer, refusals and deletion", () => {
  it("nom is read without the kernel; lancer and arreter go to the kernel", async () => {
    const { h, lances, arretes: stoppedList, creer: create } = host();
    expect(await create(null).nom("gitlab")).toBe("GitLab");
    expect(await h.nom("absente")).toBeNull();
    expect(await h.lancer("leboncoin", "clio")).toEqual({ statut: "reussie", execution: "x" });
    h.arreter("leboncoin");
    expect(lances).toEqual([{ id: "leboncoin", saisie: "clio" }]);
    expect(stoppedList).toEqual(["leboncoin"]);
    expect(await create(null).lancer("gitlab", null)).toEqual({ statut: "invalide", erreur: MESSAGE_SANS_NOYAU });
  });

  it("executions and execution read the disk without the kernel and refuse bad ids; page is refused", async () => {
    const { creer: create, dossierActions } = host();
    const ex = await executer(dossierActions, "gitlab", { a: 1 });
    const h = create(null);
    expect((await h.executions("gitlab")).map((e) => e.id)).toEqual([ex]);
    expect(await h.executions("../x")).toEqual([]);
    expect((await h.execution("gitlab", ex))?.id).toBe(ex);
    expect(await h.execution("gitlab", "../x")).toBeNull();
    expect(await h.execution("../x", ex)).toBeNull();
    expect(await h.direct()).toEqual({ courantes: [], enAttente: [] });
    // The page is the kernel's: refused without it, so the chrome reads it again once the kernel runs.
    await expect(h.page("gitlab", null)).rejects.toThrow(MESSAGE_SANS_NOYAU);
  });

  // actions.test.ts:462
  it("a launch refused without a run written is shown by the list, until a more recent run", async () => {
    const issue: LaunchResult = { statut: "echouee", erreur: "Docker n'est pas démarré", erreurNoyau: true };
    const { h, dossierActions, changes, avancer: advance } = host({ issue });
    await h.lancer("gitlab", null);
    expect(changes()).toBe(1);
    expect((await h.liste()).find((a) => a.id === "gitlab")?.refus).toBe("Docker n'est pas démarré");
    expect((await h.liste()).find((a) => a.id === "leboncoin")?.refus).toBeUndefined();
    advance(1000);
    await executer(dossierActions, "gitlab", { a: 1 });
    expect((await h.liste()).find((a) => a.id === "gitlab")?.refus).toBeUndefined();
  });

  // actions.test.ts:476
  it("a launch refusal survives a restart; launching again clears it from the disk too", async () => {
    const issue: LaunchResult = { statut: "echouee", erreur: "Docker n'est pas démarré", erreurNoyau: true };
    const { h, creer: create } = host({ issue });
    await h.lancer("gitlab", null);
    await expect.poll(async () => (await h.liste()).find((a) => a.id === "gitlab")?.refus).toBe("Docker n'est pas démarré");
    const after = create(fakeKernel(undefined, { statut: "reussie", execution: "x" }).noyau);
    await expect.poll(async () => (await after.liste()).find((a) => a.id === "gitlab")?.refus).toBe("Docker n'est pas démarré");
    await after.lancer("gitlab", null);
    await expect.poll(async () => (await create().liste()).find((a) => a.id === "gitlab")?.refus).toBeUndefined();
  });

  // actions.test.ts:491
  it("deleting also clears the refusal from the disk: an action made again has none at the next start", async () => {
    const issue: LaunchResult = { statut: "echouee", erreur: "Docker n'est pas démarré", erreurNoyau: true };
    const { h, c, creer: create } = host({ issue });
    await h.lancer("gitlab", null);
    await expect.poll(async () => (await h.liste()).find((a) => a.id === "gitlab")?.refus).toBe("Docker n'est pas démarré");
    const declaration = readFileSync(join(c.actions, "gitlab", "action.json"));
    expect(await h.supprimer("gitlab")).toEqual({ ok: true });
    mkdirSync(join(c.actions, "gitlab"), { recursive: true });
    writeFileSync(join(c.actions, "gitlab", "action.json"), declaration);
    const denialOf = async () => {
      const a = (await create().liste()).find((x) => x.id === "gitlab");
      return a ? (a.refus ?? "aucun") : "absente";
    };
    await expect.poll(denialOf).toBe("aucun");
  });

  // actions.test.ts:508
  it("lancer notes a refusal without a run; an outcome with a run leaves none", async () => {
    const { h, changes } = host({ issue: { statut: "invalide", erreur: "Cette action n'a pas de workflow.json", erreurNoyau: true } });
    await h.lancer("gitlab", null);
    expect((await h.liste()).find((a) => a.id === "gitlab")?.refus).toBe("Cette action n'a pas de workflow.json");
    expect((await h.lancer("gitlab", null)).erreur).toBe("Cette action n'a pas de workflow.json");
    expect(changes()).toBe(2);
    const ok = host();
    await ok.h.lancer("gitlab", null);
    expect((await ok.h.liste()).find((a) => a.id === "gitlab")?.refus).toBeUndefined();
    expect(ok.changes()).toBe(0);
  });

  // actions.test.ts:523
  it("deleting and removing the grant stop the running action first", async () => {
    const { h, appels: calls } = host();
    await h.refuserAccord("gitlab");
    expect(calls).toEqual(["arreter:gitlab", "refuserAccord:gitlab"]);
    calls.length = 0;
    expect(await h.supprimer("gitlab")).toEqual({ ok: true });
    expect(calls).toEqual(["arreter:gitlab", "refuserAccord:gitlab"]);
    expect(await h.supprimer("gitlab")).toEqual({ ok: false, erreur: "Action inconnue" });
  });

  // actions.test.ts:532
  it("deleting during a launch: the stopped run that ends writing nothing leaves no refusal for an action made again", async () => {
    let finish!: (r: LaunchResult) => void;
    const issue = new Promise<LaunchResult>((ok) => (finish = ok));
    const { h, changes } = host({ issue });
    void h.lancer("gitlab", null);
    expect(await h.supprimer("gitlab")).toEqual({ ok: true });
    finish({ statut: "echouee", erreur: "Action inconnue", erreurNoyau: true });
    await new Promise((ok) => setTimeout(ok, 0));
    expect(changes()).toBe(0);
    expect((await h.liste()).find((a) => a.id === "gitlab")?.refus).toBeUndefined();
  });

  it("accorder answers the kernel's refusal as an error", async () => {
    const { h, creer: create } = host();
    expect(await h.accorder({ id: "gitlab", profil: "defaut", compte: ["gitlab.com"], publiques: [] })).toEqual({ ok: true });
    expect(await create(null).accorder({ id: "gitlab", profil: "defaut", compte: [], publiques: [] })).toEqual({ ok: false, erreur: MESSAGE_SANS_NOYAU });
  });
});

describe("directVu", () => {
  it("calls surChange once when a run leaves courantes", () => {
    const { h, changes } = host();
    const courante = { action: "gitlab", debut: DEBUT, saisie: null, essai: false, etape: "workflow", blocs: {} } as unknown as ActionsState["courantes"][number];
    h.directVu({ courantes: [courante], enAttente: [] });
    expect(changes()).toBe(0);
    h.directVu({ courantes: [courante], enAttente: [] });
    expect(changes()).toBe(0);
    h.directVu({ courantes: [], enAttente: [] });
    expect(changes()).toBe(1);
    h.directVu({ courantes: [], enAttente: [] });
    expect(changes()).toBe(1);
  });
});
