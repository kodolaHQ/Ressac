import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { cheminsEspace, type CheminsEspace } from "../../src/chemins.js";
import { PontFactice } from "../../src/mcp/pont-factice.js";
import { accorder, retirerAccord } from "../../src/widgets/accords.js";
import { ACTION_ARRETEE, lireExecution, listerExecutions } from "../../src/workflows/executions.js";
import { lireMemoire } from "../../src/workflows/memoire.js";
import type { LanceurProcessus, TraceDirecte } from "../../src/workflows/executer.js";
import type { AccesIaExecution } from "../../src/ia/repartiteur.js";
import { dernierResultat, lireResultat } from "../../src/actions/donnees.js";
import { ACTION_INCONNUE, accordRequisAction, executerAction, saisieRequise, type OptionsAction, type TraceAction } from "../../src/actions/executer.js";
import { DeclarationAction } from "../../src/actions/schemas.js";
import { dossierTemporaire } from "../aide/temporaire.js";

const MOTEUR = join(import.meta.dirname, "..", "..", "docker", "moteur");
const SCRIPT = join(MOTEUR, "recolteur.mjs");
let instant = Date.parse("2026-10-31T10:00:00.000Z");
// Chaque appel avance d'une seconde : deux exécutions de suite n'ont pas le même id.
const horloge = () => new Date((instant += 1000));

const PLAN = {
  blocs: [
    { composant: "titre", props: { texte: "Tickets" } },
    { composant: "liste", props: { elements: "tickets", titre: "titre" } },
  ],
};

/** Un faux Gemma (accès d'une exécution) : `reponse` rend le plan ; ses appels sont comptés. */
function fauxGemma(reponse: (o?: { signal?: AbortSignal; auDemarrage?: () => void }) => Promise<unknown> = async () => PLAN) {
  const appels: string[] = [];
  const ia: AccesIaExecution & { appels: string[] } = {
    appels,
    kev: async () => ({}),
    gemma: async (g, o) => {
      appels.push(g.prompt);
      o?.auDemarrage?.();
      return reponse(o) as never;
    },
    oublier: () => {},
  };
  return ia;
}

const aNettoyer: string[] = [];
afterEach(async () => {
  await Promise.all(aNettoyer.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

interface Banc {
  c: CheminsEspace;
  dossierActions: string;
  dossier: string;
  commandes: string[][];
  supprimes: unknown[];
  pont: PontFactice;
  lancer: LanceurProcessus;
}

const workflow = () =>
  JSON.stringify({
    version: 1,
    blocs: [{ id: "lire", type: "code", parametres: { source: "lire.mjs" } }, { id: "sortie", type: "sortie", parametres: { vers: "page" } }],
    liens: [{ de: "lire", vers: "sortie" }],
  });

async function preparer(id: string, declaration: unknown, code: string, o: { suspendues?: string[] } = {}): Promise<Banc> {
  const racine = await dossierTemporaire();
  const c = cheminsEspace(racine);
  const dossier = join(c.actions, id);
  await mkdir(dossier, { recursive: true });
  await mkdir(c.composants, { recursive: true });
  await writeFile(join(dossier, "action.json"), JSON.stringify(declaration));
  await writeFile(join(dossier, "workflow.json"), workflow());
  await writeFile(join(dossier, "lire.mjs"), code);
  const dossierActions = await dossierTemporaire();
  aNettoyer.push(racine, dossierActions);
  const pont = new PontFactice([], {
    actif: null,
    autoriser: false,
    lecture: { pages: [{ url: "https://gitlab.com/tickets", titre: "Ouvrir la porte", texte: "", liens: [] }], ...(o.suspendues ? { suspendues: o.suspendues } : {}) },
  });
  const b: Banc = {
    c,
    dossierActions,
    dossier,
    commandes: [],
    supprimes: [],
    pont,
    lancer: (cmd, args) => {
      b.commandes.push([cmd, ...args]);
      const e = spawn(process.execPath, [SCRIPT, dossier], { stdio: ["pipe", "pipe", "pipe"] });
      return { stdin: e.stdin, stdout: e.stdout, stderr: e.stderr, tuer: () => void e.kill("SIGKILL"), fin: new Promise((ok) => e.on("close", (x) => ok(x))) };
    },
  };
  return b;
}

const options = (b: Banc, id: string, o: Partial<OptionsAction> = {}): OptionsAction => ({
  id,
  chemins: b.c,
  dossierActions: b.dossierActions,
  moteur: MOTEUR,
  atelier: {
    commandeRecolte: (p, d, m) => ["docker", "run", JSON.stringify(p), d, m],
    supprimerRecolte: async (p) => void b.supprimes.push(p),
  },
  lancer: b.lancer,
  pont: b.pont,
  ia: fauxGemma(),
  horloge,
  saisie: null,
  declencheur: "manuelle",
  signal: new AbortController().signal,
  surTrace: () => {},
  surEtape: () => {},
  adressesLocales: true,
  ...o,
});

const GITLAB = { nom: "GitLab", sources: { compte: ["gitlab.com"] }, miseEnPage: "Les tickets en liste" };
const CODE_GITLAB = `export default async (e, w) => { const p = await w.lirePage("https://gitlab.com/tickets", { compte: true }); return { tickets: [{ titre: p.titre }] }; };`;
const accordGitlab = (b: Banc) => accorder(b.dossierActions, "gitlab", { domaines: ["gitlab.com"], publiques: [], profil: "perso" });

describe("executerAction", () => {
  it("action GitLab avec accord : exécution reussie, résultat et plan écrits, statut reussie", async () => {
    const b = await preparer("gitlab", GITLAB, CODE_GITLAB);
    await accordGitlab(b);
    const ia = fauxGemma();
    const etapes: string[] = [];
    const r = await executerAction(options(b, "gitlab", { ia, surEtape: (e) => etapes.push(e) }));
    expect(r).toMatchObject({ statut: "reussie" });
    expect(r.execution).toBeDefined();
    const e = await lireExecution(join(b.dossierActions, "gitlab"), r.execution!);
    expect(e).toMatchObject({ statut: "reussie", proprietaire: { type: "action", id: "gitlab" }, declencheur: "manuelle" });
    const res = await lireResultat(b.dossierActions, "gitlab", r.execution!);
    expect(res).toEqual({
      version: 1,
      execution: r.execution,
      saisie: null,
      resultats: { tickets: [{ titre: "Ouvrir la porte" }] },
      plan: PLAN,
      secours: false,
      vide: false,
    });
    expect(ia.appels).toHaveLength(1);
    // La consigne de l'action est donnée à Gemma.
    expect(ia.appels[0]).toContain("Les tickets en liste");
    expect(etapes).toEqual(["mise-en-page"]);
  });

  it("sans accord : accord-requis, aucun conteneur lancé, rien écrit", async () => {
    const b = await preparer("gitlab", GITLAB, CODE_GITLAB);
    const r = await executerAction(options(b, "gitlab"));
    expect(r).toEqual({ statut: "accord-requis", erreur: accordRequisAction(DeclarationAction.parse(GITLAB)), erreurNoyau: true });
    expect(r.erreur).toBe("Accord requis pour lire avec ton compte : gitlab.com");
    expect(b.commandes).toEqual([]);
    expect(existsSync(join(b.dossierActions, "gitlab"))).toBe(false);
  });

  it("un accord périmé (domaines changés) est retiré, les données effacées", async () => {
    const b = await preparer("gitlab", GITLAB, CODE_GITLAB);
    await accordGitlab(b);
    const premiere = await executerAction(options(b, "gitlab"));
    expect(premiere.statut).toBe("reussie");
    await writeFile(join(b.dossier, "action.json"), JSON.stringify({ ...GITLAB, sources: { compte: ["gitlab.com", "github.com"] } }));
    const r = await executerAction(options(b, "gitlab"));
    expect(r.statut).toBe("accord-requis");
    expect(await listerExecutions(join(b.dossierActions, "gitlab"))).toEqual([]);
  });

  it("action inconnue : ACTION_INCONNUE, rien écrit", async () => {
    const b = await preparer("gitlab", GITLAB, CODE_GITLAB);
    const r = await executerAction(options(b, "absente"));
    expect(r).toMatchObject({ statut: "invalide", erreur: ACTION_INCONNUE });
    expect(existsSync(join(b.dossierActions, "absente"))).toBe(false);
  });

  it("workflow invalide : statut invalide, rien écrit, aucun conteneur", async () => {
    const b = await preparer("cassee", { nom: "C", sources: {} }, `export default async () => 1;`);
    await writeFile(join(b.dossier, "workflow.json"), "{pas du json");
    const r = await executerAction(options(b, "cassee"));
    expect(r.statut).toBe("invalide");
    expect(r.erreur).toBeTruthy();
    expect(b.commandes).toEqual([]);
    expect(existsSync(join(b.dossierActions, "cassee"))).toBe(false);
  });

  it("saisie requise absente : saisieRequise(\"Recherche\")", async () => {
    const b = await preparer("leboncoin", { nom: "Leboncoin", sources: {}, saisie: { libelle: "Recherche" } }, `export default async (e, w) => ({ q: w.saisie });`);
    for (const saisie of [null, "   "]) {
      const r = await executerAction(options(b, "leboncoin", { saisie }));
      expect(r).toEqual({ statut: "invalide", erreur: saisieRequise("Recherche"), erreurNoyau: true });
    }
    expect(saisieRequise("Recherche")).toBe("Saisie requise : Recherche");
    expect(b.commandes).toEqual([]);
  });

  it("« clio lyon » arrive dans debut.saisie et dans Execution.saisie", async () => {
    const b = await preparer("leboncoin", { nom: "Leboncoin", sources: {}, saisie: { libelle: "Recherche" } }, `export default async (e, w) => ({ annonces: [{ titre: w.saisie }] });`);
    const r = await executerAction(options(b, "leboncoin", { saisie: "  clio lyon  " }));
    expect(r.statut).toBe("reussie");
    const e = await lireExecution(join(b.dossierActions, "leboncoin"), r.execution!);
    expect(e?.saisie).toBe("clio lyon");
    const res = await lireResultat(b.dossierActions, "leboncoin", r.execution!);
    // Le code de l'agent a reçu la saisie (envoyée dans debut).
    expect(res?.resultats).toEqual({ annonces: [{ titre: "clio lyon" }] });
    expect(res?.saisie).toBe("clio lyon");
    // Le résumé aussi la porte (menu des résultats précédents de la page de l'action).
    expect((await listerExecutions(join(b.dossierActions, "leboncoin")))[0]?.saisie).toBe("clio lyon");
  });

  it("une saisie trop longue est coupée à 200 caractères", async () => {
    const b = await preparer("leboncoin", { nom: "Leboncoin", sources: {}, saisie: { libelle: "Recherche" } }, `export default async (e, w) => ({ annonces: [{ titre: w.saisie }] });`);
    const r = await executerAction(options(b, "leboncoin", { saisie: "x".repeat(500) }));
    expect(r.statut).toBe("reussie");
    expect((await lireExecution(join(b.dossierActions, "leboncoin"), r.execution!))?.saisie).toBe("x".repeat(200));
  });

  it("résultats vides : résultat vide, Gemma jamais appelée", async () => {
    const b = await preparer("vide", { nom: "V", sources: {} }, `export default async () => ({ tickets: [] });`);
    const ia = fauxGemma();
    const r = await executerAction(options(b, "vide", { ia }));
    expect(r.statut).toBe("reussie");
    const res = await lireResultat(b.dossierActions, "vide", r.execution!);
    expect(res).toMatchObject({ vide: true, plan: null, secours: false });
    expect(ia.appels).toEqual([]);
  });

  it("Gemma absente : plan de secours, secours true", async () => {
    const b = await preparer("simple", { nom: "S", sources: {} }, `export default async () => ({ tickets: [{ titre: "a" }] });`);
    const r = await executerAction(options(b, "simple", { ia: null }));
    expect(r.statut).toBe("reussie");
    const res = await lireResultat(b.dossierActions, "simple", r.execution!);
    expect(res?.secours).toBe(true);
    expect(res?.plan?.blocs.length).toBeGreaterThan(0);
  });

  it("la mémoire des blocs est écrite après le résultat ; un échec ne la touche pas", async () => {
    const b = await preparer("memo", { nom: "M", sources: {} }, `export default async () => 1;`);
    const lignes = (fin: unknown) => [
      { t: "bloc", id: "lire", etape: "debut" },
      { t: "bloc", id: "lire", etape: "fin", statut: "reussi", sortie: { tickets: [{ titre: "a" }] } },
      { t: "memoire", memoire: { lire: { type: "code", valeur: { vu: 1 } } } },
      { t: "bloc", id: "sortie", etape: "debut" },
      { t: "bloc", id: "sortie", etape: "fin", statut: "reussi", sortie: { tickets: [{ titre: "a" }] } },
      fin,
    ];
    const r = await executerAction(options(b, "memo", { lancer: lanceurLignes(lignes({ t: "fin", donnees: { tickets: [{ titre: "a" }] } })) }));
    expect(r.statut).toBe("reussie");
    expect((await lireMemoire(join(b.dossierActions, "memo"))).lire).toMatchObject({ type: "code", valeur: { vu: 1 } });
    const echec = await executerAction(options(b, "memo", { lancer: lanceurLignes([{ t: "memoire", memoire: { lire: { type: "code", valeur: { vu: 2 } } } }, { t: "echec", erreur: "cassé" }]) }));
    expect(echec.statut).toBe("echouee");
    expect((await lireMemoire(join(b.dossierActions, "memo"))).lire).toMatchObject({ valeur: { vu: 1 } });
  });

  it("accord retiré pendant l'exécution : rien ne reste", async () => {
    const b = await preparer("gitlab", GITLAB, CODE_GITLAB, { suspendues: ["https://gitlab.com/tickets"] });
    await accordGitlab(b);
    const fin = executerAction(options(b, "gitlab"));
    await attendreQue(() => b.pont.appels.some((a) => a.methode === "lirePageInvisible"));
    await retirerAccord(b.dossierActions, "gitlab");
    b.pont.relacher("https://gitlab.com/tickets");
    const r = await fin;
    expect(r.statut).toBe("accord-requis");
    expect(r.execution).toBeUndefined();
    expect(await listerExecutions(join(b.dossierActions, "gitlab"))).toEqual([]);
    expect(await dernierResultat(b.dossierActions, "gitlab")).toBeNull();
  });

  it("dossier supprimé pendant : rien n'est écrit", async () => {
    const b = await preparer("public", { nom: "P", sources: { publiques: ["gitlab.com"] } }, `export default async (e, w) => ({ tickets: [{ titre: (await w.lirePage("https://gitlab.com/tickets")).titre }] });`, {
      suspendues: ["https://gitlab.com/tickets"],
    });
    const fin = executerAction(options(b, "public"));
    await attendreQue(() => b.pont.appels.some((a) => a.methode === "lirePageInvisible"));
    await rm(b.dossier, { recursive: true, force: true });
    b.pont.relacher("https://gitlab.com/tickets");
    const r = await fin;
    expect(r.execution).toBeUndefined();
    expect(r.statut).toBe("invalide");
    expect(r.erreur).toBe(ACTION_INCONNUE);
    expect(await listerExecutions(join(b.dossierActions, "public"))).toEqual([]);
  });

  it("dossier des actions introuvable un moment pendant l'exécution : rien n'est écrit, l'historique reste", async () => {
    const b = await preparer("public", { nom: "P", sources: { publiques: ["gitlab.com"] } }, `export default async (e, w) => ({ tickets: [{ titre: (await w.lirePage("https://gitlab.com/tickets")).titre }] });`);
    const premiere = await executerAction(options(b, "public"));
    expect(premiere.statut).toBe("reussie");
    const avantMemoire = await lireMemoire(join(b.dossierActions, "public"));
    // Pendant la mise en page de la seconde, le dossier des actions disparaît (volume démonté, renommé…).
    const ailleurs = `${b.c.actions}-ailleurs`;
    const ia = fauxGemma(async () => {
      await rename(b.c.actions, ailleurs);
      return PLAN;
    });
    const r = await executerAction(options(b, "public", { ia }));
    await rename(ailleurs, b.c.actions);
    expect(r).toMatchObject({ statut: "invalide", erreur: ACTION_INCONNUE });
    expect((await listerExecutions(join(b.dossierActions, "public"))).map((e) => e.id)).toEqual([premiere.execution]);
    expect((await dernierResultat(b.dossierActions, "public"))?.execution).toBe(premiere.execution);
    expect(await lireMemoire(join(b.dossierActions, "public"))).toEqual(avantMemoire);
  });

  it("arrêt du noyau pendant la mise en page : exécution interrompue, sans résultat", async () => {
    const b = await preparer("simple", { nom: "S", sources: {} }, `export default async () => ({ tickets: [{ titre: "a" }] });`);
    const arret = new AbortController();
    let quitte = false;
    const ia = fauxGemma(
      (o) =>
        new Promise((_ok, ko) => {
          o?.signal?.addEventListener("abort", () => ko(new Error("abandon")));
          setImmediate(() => {
            quitte = true;
            arret.abort();
          });
        }),
    );
    const r = await executerAction(options(b, "simple", { ia, signal: arret.signal, interrompue: () => quitte }));
    expect(r).toMatchObject({ statut: "interrompue", erreur: "Interrompue : WebAiOs s'est arrêté", erreurNoyau: true });
    expect(await lireExecution(join(b.dossierActions, "simple"), r.execution!)).toMatchObject({ statut: "interrompue" });
    expect(await lireResultat(b.dossierActions, "simple", r.execution!)).toBeNull();
  });

  it("signal levé pendant le workflow : interrompue, ACTION_ARRETEE ; pendant la mise en page : reussie avec plan de secours", async () => {
    const b = await preparer("public", { nom: "P", sources: { publiques: ["gitlab.com"] } }, `export default async (e, w) => ({ tickets: [{ titre: (await w.lirePage("https://gitlab.com/tickets")).titre }] });`, {
      suspendues: ["https://gitlab.com/tickets"],
    });
    const arret = new AbortController();
    const fin = executerAction(options(b, "public", { signal: arret.signal }));
    await attendreQue(() => b.pont.appels.some((a) => a.methode === "lirePageInvisible"));
    arret.abort();
    const r = await fin;
    expect(r).toMatchObject({ statut: "interrompue", erreur: ACTION_ARRETEE, erreurNoyau: true });
    const e = await lireExecution(join(b.dossierActions, "public"), r.execution!);
    expect(e).toMatchObject({ statut: "interrompue", erreur: ACTION_ARRETEE });
    expect(await lireResultat(b.dossierActions, "public", r.execution!)).toBeNull();

    // Pendant la mise en page : Gemma attend, l'arrêt donne la mise en page de secours.
    const b2 = await preparer("simple", { nom: "S", sources: {} }, `export default async () => ({ tickets: [{ titre: "a" }] });`);
    const arret2 = new AbortController();
    const ia = fauxGemma(
      (o) =>
        new Promise((_ok, ko) => {
          o?.signal?.addEventListener("abort", () => ko(new Error("abandon")));
          setImmediate(() => arret2.abort());
        }),
    );
    const r2 = await executerAction(options(b2, "simple", { ia, signal: arret2.signal }));
    expect(r2.statut).toBe("reussie");
    expect((await lireResultat(b2.dossierActions, "simple", r2.execution!))?.secours).toBe(true);
  });

  it("arrêt du noyau (interrompue) : exécution écrite interrompue", async () => {
    const b = await preparer("public", { nom: "P", sources: { publiques: ["gitlab.com"] } }, `export default async (e, w) => ({ tickets: [{ titre: (await w.lirePage("https://gitlab.com/tickets")).titre }] });`, {
      suspendues: ["https://gitlab.com/tickets"],
    });
    const arret = new AbortController();
    const fin = executerAction(options(b, "public", { signal: arret.signal, interrompue: () => true }));
    await attendreQue(() => b.pont.appels.some((a) => a.methode === "lirePageInvisible"));
    arret.abort();
    const r = await fin;
    expect(r.statut).toBe("interrompue");
    const e = await lireExecution(join(b.dossierActions, "public"), r.execution!);
    expect(e).toMatchObject({ statut: "interrompue", erreur: "Interrompue : WebAiOs s'est arrêté", erreurNoyau: true });
  });

  it("les traces du workflow sont relayées", async () => {
    const b = await preparer("simple", { nom: "S", sources: {} }, `export default async () => ({ tickets: [{ titre: "a" }] });`);
    const traces: TraceAction[] = [];
    await executerAction(options(b, "simple", { surTrace: (t) => traces.push(t) }));
    expect(traces).toContainEqual({ bloc: "lire", etape: "debut", type: "code" });
    // Chaque trace porte le type du bloc : la page de l'action montre son libellé du catalogue.
    expect(traces.every((t) => t.type === (t.bloc === "lire" ? "code" : "sortie"))).toBe(true);
  });

  it("essai : exécution -essai, résultat écrit, ni mémoire ni dernier résultat changés", async () => {
    const b = await preparer("simple", { nom: "S", sources: {} }, `export default async () => ({ tickets: [{ titre: "a" }] });`);
    const vraie = await executerAction(options(b, "simple"));
    expect(vraie.statut).toBe("reussie");
    const memoireAvant = await lireMemoire(join(b.dossierActions, "simple"));
    const ia = fauxGemma();
    const r = await executerAction(options(b, "simple", { ia, declencheur: "rejeu", essai: { origine: vraie.execution!, depart: "lire" } }));
    expect(r.statut).toBe("reussie");
    expect(r.execution).toMatch(/-essai$/);
    const e = await lireExecution(join(b.dossierActions, "simple"), r.execution!);
    expect(e).toMatchObject({ declencheur: "rejeu", essai: { depart: "lire", origine: vraie.execution } });
    expect((await lireResultat(b.dossierActions, "simple", r.execution!))?.plan).toEqual(PLAN);
    expect((await dernierResultat(b.dossierActions, "simple"))?.execution).toBe(vraie.execution);
    expect(await lireMemoire(join(b.dossierActions, "simple"))).toEqual(memoireAvant);
  });

  it("essai depuis une exécution introuvable : refusé, rien écrit", async () => {
    const b = await preparer("simple", { nom: "S", sources: {} }, `export default async () => ({ tickets: [{ titre: "a" }] });`);
    const r = await executerAction(options(b, "simple", { declencheur: "rejeu", essai: { origine: "2020-01-01T00-00-00-000Z", depart: "lire" } }));
    expect(r.statut).toBe("invalide");
    expect(b.commandes).toEqual([]);
  });
});

/** Un faux conteneur qui écrit ces lignes puis sort avec 0. */
function lanceurLignes(lignes: unknown[]): LanceurProcessus {
  return () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();
    const fin = new Promise<number | null>((ok) => {
      setImmediate(() => {
        for (const l of lignes) stdout.write(JSON.stringify(l) + "\n");
        stdout.end();
        stderr.end();
        setImmediate(() => ok(0));
      });
    });
    return { stdin, stdout, stderr, tuer: () => {}, fin };
  };
}

async function attendreQue(f: () => boolean, ms = 5000): Promise<void> {
  const fin = Date.now() + ms;
  while (!f()) {
    if (Date.now() > fin) throw new Error("attente dépassée");
    await new Promise((ok) => setTimeout(ok, 10));
  }
}
