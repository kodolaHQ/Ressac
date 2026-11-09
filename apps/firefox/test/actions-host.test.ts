import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  accorder,
  cheminsEspace,
  ecrireExecution,
  ecrireResultat,
  idExecution,
  lireAction,
  type ActionsNoyau,
  type CheminsEspace,
  type EtatActions,
  type Execution,
  type LancementAction,
  type Noyau,
  type ResultatLancement,
} from "../../../packages/noyau/src/index";
import { actionImageAllowed, createActionsHost, linkAllowed, MESSAGE_SANS_NOYAU, readShownActions, trashAction } from "../noyau/actions";
import { SchemaAccord, SchemaIdAction, SchemaSaisieAction } from "../shared/api";

const DEBUT = "2026-10-31T10:00:00.000Z";
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A temporary space with these actions (`action.json`), and the folder of their data outside the space. */
function espace(declarations: Record<string, object>): { c: CheminsEspace; dossierActions: string } {
  const racine = mkdtempSync(join(tmpdir(), "webaios-actions-host-"));
  dirs.push(racine);
  const c = cheminsEspace(join(racine, "WebAiOs"));
  for (const [id, d] of Object.entries(declarations)) {
    mkdirSync(join(c.actions, id), { recursive: true });
    writeFileSync(join(c.actions, id, "action.json"), JSON.stringify(d));
  }
  return { c, dossierActions: join(racine, "profil", "actions") };
}

/** A kept run of the action, with its results; gives its id. */
async function executer(dossierActions: string, id: string, resultats: unknown, debut = DEBUT): Promise<string> {
  const ex = idExecution(debut);
  const e: Execution = { version: 1, id: ex, proprietaire: { type: "action", id }, declencheur: "manuelle", debut, fin: debut, statut: "reussie", blocs: [] };
  await ecrireExecution(join(dossierActions, id), e);
  await ecrireResultat(dossierActions, id, { version: 1, execution: ex, saisie: null, resultats, plan: null, secours: true, vide: false });
  return ex;
}

describe("input schemas", () => {
  it("accept and refuse these ids, inputs and accords", () => {
    const accord = { id: "gitlab", profil: "defaut", compte: ["gitlab.com"], publiques: [] };
    const ok = (sc: { safeParse: (v: unknown) => { success: boolean } }, vs: unknown[]) => vs.map((v) => sc.safeParse(v).success);
    expect(ok(SchemaIdAction, ["gitlab", "a-1", "", "Git_Lab", "../x", "a".repeat(60), "a".repeat(61), 3, null])).toEqual([true, true, false, false, false, true, false, false, false]);
    expect(ok(SchemaSaisieAction, [null, "", "x".repeat(2000), "x".repeat(2001), 4, undefined])).toEqual([true, true, true, false, false, false]);
    expect(ok(SchemaAccord, [accord, { ...accord, extra: 1 }, { ...accord, id: "../x" }, { ...accord, profil: "" }, { ...accord, compte: [""] }, { ...accord, publiques: Array(101).fill("a.b") }, null])).toEqual([true, false, false, false, false, false, false]);
  });
});

describe("actionImageAllowed", () => {
  // actions.test.ts:116
  it("allows an https address present as is in the results of a run of an action without account", async () => {
    const { c, dossierActions } = espace({ leboncoin: { nom: "Leboncoin", sources: { web: true } } });
    const image = "https://img.test/annonce/1.jpg?rule=ad-large";
    const ex = await executer(dossierActions, "leboncoin", { annonces: [{ titre: "Clio", photo: image }] });
    expect(await actionImageAllowed({ dossierActions, lireAction: (id) => lireAction(c, id) }, "leboncoin", ex, image)).toBe(true);
  });

  // actions.test.ts:202
  it("refuses an action that has an account accord, even if its declaration no longer has an account", async () => {
    const { c, dossierActions } = espace({ reecrite: { nom: "Réécrite", sources: { web: true } } });
    const image = "https://img.test/a.jpg";
    const ex = await executer(dossierActions, "reecrite", { photo: image });
    await accorder(dossierActions, "reecrite", { domaines: ["gitlab.com"], publiques: [], profil: "defaut" });
    expect(await actionImageAllowed({ dossierActions, lireAction: (id) => lireAction(c, id) }, "reecrite", ex, image)).toBe(false);
  });
});

describe("pure helpers", () => {
  // actions.test.ts:285
  it("linkAllowed: only an openable http(s) address present as is in the run's results", async () => {
    const { dossierActions } = espace({});
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
    const { c } = espace({ gitlab: { nom: "GitLab" } });
    const oublies: string[] = [];
    await trashAction(c, "gitlab", async (id) => void oublies.push(id));
    expect(existsSync(join(c.actions, "gitlab"))).toBe(false);
    const corbeille = readdirSync(join(c.actions, ".corbeille"));
    expect(corbeille).toHaveLength(1);
    expect(corbeille[0]).toMatch(/^gitlab-\d+$/);
    expect(readFileSync(join(c.actions, ".corbeille", corbeille[0]!, "action.json"), "utf8")).toContain("GitLab");
    expect(oublies).toEqual(["gitlab"]);
    await expect(trashAction(c, "../x", async () => {})).rejects.toThrow();
  });

  // actions.test.ts:309
  it("readShownActions: declaration, accord, last result (not a trial), broken action flagged", async () => {
    const { c, dossierActions } = espace({
      gitlab: { nom: "GitLab", description: "Mes tickets", motsCles: ["tickets"], sources: { compte: ["gitlab.com"] } },
      leboncoin: { nom: "Leboncoin", saisie: { libelle: "Recherche" }, sources: { web: true } },
    });
    mkdirSync(join(c.actions, "cassee"), { recursive: true });
    writeFileSync(join(c.actions, "cassee", "action.json"), "{");
    const ex = await executer(dossierActions, "leboncoin", { a: 1 });
    const liste = await readShownActions(c, dossierActions);
    expect(liste.map((a) => a.id)).toEqual(["cassee", "gitlab", "leboncoin"]);
    expect(liste[0]).toMatchObject({ id: "cassee", nom: "cassee", motsCles: [], saisie: null, compte: [], accord: false, dernier: null });
    expect(liste[0]!.erreur).toBeTruthy();
    expect(liste[1]).toEqual({ id: "gitlab", nom: "GitLab", description: "Mes tickets", motsCles: ["tickets"], saisie: null, compte: ["gitlab.com"], publiques: [], accord: false, dernier: null });
    expect(liste[2]).toEqual({ id: "leboncoin", nom: "Leboncoin", description: "", motsCles: [], saisie: { libelle: "Recherche" }, compte: [], publiques: [], accord: false, dernier: { execution: ex, debut: DEBUT, statut: "reussie" } });
  });
});

/** A fake noyau of the actions: notes the launches and stops. */
function fauxNoyau(direct: EtatActions = { courantes: [], enAttente: [] }, issue: ResultatLancement | Promise<ResultatLancement> = { statut: "reussie", execution: "x" }) {
  const lances: { id: string; saisie?: string }[] = [];
  const arretes: string[] = [];
  /** Stops and accord removals, in order. */
  const appels: string[] = [];
  const actions = {
    lancer: (id: string, o: { saisie?: string }): LancementAction => {
      lances.push({ id, ...(o.saisie !== undefined ? { saisie: o.saisie } : {}) });
      return { deja: false, fin: Promise.resolve(issue) };
    },
    arreter: (id: string) => {
      arretes.push(id);
      appels.push(`arreter:${id}`);
    },
    direct: () => direct,
    page: async () => null,
    executions: async () => [],
    accorder: async () => {},
    refuserAccord: async (id: string) => void appels.push(`refuserAccord:${id}`),
  } as unknown as ActionsNoyau;
  return { lances, arretes, appels, noyau: { actions } as unknown as Noyau };
}

function host(o: { direct?: EtatActions; issue?: ResultatLancement | Promise<ResultatLancement>; sansNoyau?: boolean } = {}) {
  const { c, dossierActions } = espace({
    gitlab: { nom: "GitLab", sources: { compte: ["gitlab.com"] } },
    leboncoin: { nom: "Leboncoin", saisie: { libelle: "Recherche" }, sources: { web: true } },
  });
  const faux = fauxNoyau(o.direct, o.issue);
  let changes = 0;
  let horloge = 10_000;
  const creer = (noyau: Noyau | null = faux.noyau) =>
    createActionsHost({ chemins: c, dossierActions, noyau: () => (o.sansNoyau ? null : noyau), surChange: () => void changes++, maintenant: () => horloge });
  return { h: creer(), creer, c, dossierActions, ...faux, changes: () => changes, avancer: (ms: number) => (horloge += ms) };
}

describe("preparer", () => {
  // actions.test.ts:413
  it("reads without launching: running, waiting or missing input give lancer false", async () => {
    const { h, lances } = host();
    expect(await h.preparer("gitlab", null)).toEqual({ ok: true, nom: "GitLab", lancer: true });
    expect(await h.preparer("leboncoin", "clio lyon")).toEqual({ ok: true, nom: "Leboncoin", lancer: true });
    expect(await h.preparer("leboncoin", null)).toEqual({ ok: true, nom: "Leboncoin", lancer: false });
    expect(await h.preparer("leboncoin", "  ")).toEqual({ ok: true, nom: "Leboncoin", lancer: false });
    const courante = { action: "gitlab", debut: DEBUT, saisie: null, essai: false, etape: "workflow", blocs: {} } as unknown as EtatActions["courantes"][number];
    expect(await host({ direct: { courantes: [courante], enAttente: [] } }).h.preparer("gitlab", null)).toEqual({ ok: true, nom: "GitLab", lancer: false });
    expect(await host({ direct: { courantes: [], enAttente: [{ action: "gitlab", depuis: DEBUT }] } }).h.preparer("gitlab", null)).toMatchObject({ lancer: false });
    expect(lances).toEqual([]);
  });

  // actions.test.ts:423
  it("an unknown action or a missing noyau is refused", async () => {
    const { h } = host();
    expect(await h.preparer("inconnue", null)).toEqual({ ok: false, erreur: "Action inconnue" });
    expect(await h.preparer("../x", null)).toEqual({ ok: false, erreur: "Action inconnue" });
    expect(await host({ sansNoyau: true }).h.preparer("gitlab", null)).toEqual({ ok: false, erreur: MESSAGE_SANS_NOYAU });
  });
});

describe("lancer, refusals and deletion", () => {
  it("nom is read without the noyau; lancer and arreter go to the noyau", async () => {
    const { h, lances, arretes, creer } = host();
    expect(await creer(null).nom("gitlab")).toBe("GitLab");
    expect(await h.nom("absente")).toBeNull();
    expect(await h.lancer("leboncoin", "clio")).toEqual({ statut: "reussie", execution: "x" });
    h.arreter("leboncoin");
    expect(lances).toEqual([{ id: "leboncoin", saisie: "clio" }]);
    expect(arretes).toEqual(["leboncoin"]);
    expect(await creer(null).lancer("gitlab", null)).toEqual({ statut: "invalide", erreur: MESSAGE_SANS_NOYAU });
  });

  it("executions and execution read the disk without the noyau and refuse bad ids; page is refused", async () => {
    const { creer, dossierActions } = host();
    const ex = await executer(dossierActions, "gitlab", { a: 1 });
    const h = creer(null);
    expect((await h.executions("gitlab")).map((e) => e.id)).toEqual([ex]);
    expect(await h.executions("../x")).toEqual([]);
    expect((await h.execution("gitlab", ex))?.id).toBe(ex);
    expect(await h.execution("gitlab", "../x")).toBeNull();
    expect(await h.execution("../x", ex)).toBeNull();
    expect(await h.direct()).toEqual({ courantes: [], enAttente: [] });
    // The page is the noyau's: refused without it, so the chrome reads it again once the noyau runs.
    await expect(h.page("gitlab", null)).rejects.toThrow(MESSAGE_SANS_NOYAU);
  });

  // actions.test.ts:462
  it("a launch refused without a run written is shown by the list, until a more recent run", async () => {
    const issue: ResultatLancement = { statut: "echouee", erreur: "Docker n'est pas démarré", erreurNoyau: true };
    const { h, dossierActions, changes, avancer } = host({ issue });
    await h.lancer("gitlab", null);
    expect(changes()).toBe(1);
    expect((await h.liste()).find((a) => a.id === "gitlab")?.refus).toBe("Docker n'est pas démarré");
    expect((await h.liste()).find((a) => a.id === "leboncoin")?.refus).toBeUndefined();
    avancer(1000);
    await executer(dossierActions, "gitlab", { a: 1 });
    expect((await h.liste()).find((a) => a.id === "gitlab")?.refus).toBeUndefined();
  });

  // actions.test.ts:476
  it("a launch refusal survives a restart; launching again clears it from the disk too", async () => {
    const issue: ResultatLancement = { statut: "echouee", erreur: "Docker n'est pas démarré", erreurNoyau: true };
    const { h, creer } = host({ issue });
    await h.lancer("gitlab", null);
    await expect.poll(async () => (await h.liste()).find((a) => a.id === "gitlab")?.refus).toBe("Docker n'est pas démarré");
    const apres = creer(fauxNoyau(undefined, { statut: "reussie", execution: "x" }).noyau);
    await expect.poll(async () => (await apres.liste()).find((a) => a.id === "gitlab")?.refus).toBe("Docker n'est pas démarré");
    await apres.lancer("gitlab", null);
    await expect.poll(async () => (await creer().liste()).find((a) => a.id === "gitlab")?.refus).toBeUndefined();
  });

  // actions.test.ts:491
  it("deleting also clears the refusal from the disk: an action made again has none at the next start", async () => {
    const issue: ResultatLancement = { statut: "echouee", erreur: "Docker n'est pas démarré", erreurNoyau: true };
    const { h, c, creer } = host({ issue });
    await h.lancer("gitlab", null);
    await expect.poll(async () => (await h.liste()).find((a) => a.id === "gitlab")?.refus).toBe("Docker n'est pas démarré");
    const declaration = readFileSync(join(c.actions, "gitlab", "action.json"));
    expect(await h.supprimer("gitlab")).toEqual({ ok: true });
    mkdirSync(join(c.actions, "gitlab"), { recursive: true });
    writeFileSync(join(c.actions, "gitlab", "action.json"), declaration);
    const refusDe = async () => {
      const a = (await creer().liste()).find((x) => x.id === "gitlab");
      return a ? (a.refus ?? "aucun") : "absente";
    };
    await expect.poll(refusDe).toBe("aucun");
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
  it("deleting and removing the accord stop the running action first", async () => {
    const { h, appels } = host();
    await h.refuserAccord("gitlab");
    expect(appels).toEqual(["arreter:gitlab", "refuserAccord:gitlab"]);
    appels.length = 0;
    expect(await h.supprimer("gitlab")).toEqual({ ok: true });
    expect(appels).toEqual(["arreter:gitlab", "refuserAccord:gitlab"]);
    expect(await h.supprimer("gitlab")).toEqual({ ok: false, erreur: "Action inconnue" });
  });

  // actions.test.ts:532
  it("deleting during a launch: the stopped run that ends writing nothing leaves no refusal for an action made again", async () => {
    let finir!: (r: ResultatLancement) => void;
    const issue = new Promise<ResultatLancement>((ok) => (finir = ok));
    const { h, changes } = host({ issue });
    void h.lancer("gitlab", null);
    expect(await h.supprimer("gitlab")).toEqual({ ok: true });
    finir({ statut: "echouee", erreur: "Action inconnue", erreurNoyau: true });
    await new Promise((ok) => setTimeout(ok, 0));
    expect(changes()).toBe(0);
    expect((await h.liste()).find((a) => a.id === "gitlab")?.refus).toBeUndefined();
  });

  it("accorder answers the noyau's refusal as an error", async () => {
    const { h, creer } = host();
    expect(await h.accorder({ id: "gitlab", profil: "defaut", compte: ["gitlab.com"], publiques: [] })).toEqual({ ok: true });
    expect(await creer(null).accorder({ id: "gitlab", profil: "defaut", compte: [], publiques: [] })).toEqual({ ok: false, erreur: MESSAGE_SANS_NOYAU });
  });
});

describe("directVu", () => {
  it("calls surChange once when a run leaves courantes", () => {
    const { h, changes } = host();
    const courante = { action: "gitlab", debut: DEBUT, saisie: null, essai: false, etape: "workflow", blocs: {} } as unknown as EtatActions["courantes"][number];
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
