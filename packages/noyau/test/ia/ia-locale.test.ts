import { afterEach, describe, expect, it, vi } from "vitest";
import { IA_ABANDONNEE } from "../../src/ia/repartiteur.js";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { IaLocale, lancerProcessusIa, type ProcessusIa } from "../../src/ia/ia-locale.js";
import { dossierTemporaire } from "../aide/temporaire.js";
import { executeurFactice, type Reponse } from "../aide/executeur-factice.js";
import type { Executeur } from "../../src/conteneur/executeur.js";
import { fauxKev, fauxOllama, fauxOllamaMuet, urlInjoignable, type FauxServeur } from "../aide/faux-ia.js";

const COMMIT = "6b719c3c3f367295f6ef336f4f751cf5ff970abc";
const aFermer: FauxServeur[] = [];
const aArreter: IaLocale[] = [];
afterEach(async () => {
  for (const ia of aArreter.splice(0)) await ia.arreter();
  for (const s of aFermer.splice(0)) await s.fermer();
});
const garder = <T extends FauxServeur>(s: T) => (aFermer.push(s), s);
const rapide = { sondageMs: 10, verifInactiviteMs: 10 };
/** git clone factice réussi : crée le dépôt dans le dossier de clonage. */
const clonage = (dossier: string) => async (): Promise<Reponse> => {
  await mkdir(join(dossier, "kev.clone-en-cours", ".git"), { recursive: true });
  return { code: 0 };
};

describe("IaLocale", () => {
  it("kev() transmet state et questions et rend answers", async () => {
    const kev = garder(await fauxKev());
    const { executer } = executeurFactice([]);
    const ia = new IaLocale({ dossier: await dossierTemporaire(), executer, kevUrl: kev.url });
    aArreter.push(ia);
    const questions = { q: { type: "noul", instructions: "ok ?" } };
    const r = await ia.kev({ state: "texte", questions });
    expect(r).toEqual({ q: { type: "noul", noul: 0.91 } });
    const req = kev.requetes.find((x) => x.url === "/v1/systemone")!;
    expect(req.methode).toBe("POST");
    expect(req.corps).toEqual({ state: "texte", questions });
  });

  it("gemma() envoie le modèle gemma4:e4b-mlx, think false, et analyse le JSON si demandé", async () => {
    const ollama = garder(await fauxOllama('{"a":1}'));
    const { executer } = executeurFactice([]);
    const ia = new IaLocale({ dossier: await dossierTemporaire(), executer, ollamaUrl: ollama.url });
    expect(await ia.gemma({ prompt: "salut", images: ["QUJD"], json: true })).toEqual({ a: 1 });
    const c = ollama.requetes[0]!.corps;
    expect(c.model).toBe("gemma4:e4b-mlx");
    expect(c.stream).toBe(false);
    expect(c.think).toBe(false);
    expect(c.keep_alive).toBe("10m");
    expect(c.format).toBe("json");
    expect(c.options).toEqual({ num_ctx: 16384, temperature: 0.2 });
    expect(c.messages[0]).toMatchObject({ role: "user", content: "salut", images: ["QUJD"] });
    expect(await ia.gemma({ prompt: "x" })).toBe('{"a":1}');
    expect(ollama.requetes[1]!.corps.format).toBeUndefined();
  });

  it("gemma avec un signal levé abandonne la requête vers Ollama (faux serveur)", async () => {
    const ollama = garder(await fauxOllamaMuet());
    const { executer } = executeurFactice([]);
    const ia = new IaLocale({ dossier: await dossierTemporaire(), executer, ollamaUrl: ollama.url });
    const controleur = new AbortController();
    const appel = ia.gemma({ prompt: "x", json: true, signal: controleur.signal });
    await vi.waitFor(() => expect(ollama.requetes).toHaveLength(1));
    controleur.abort();
    await expect(appel).rejects.toThrow(IA_ABANDONNEE);
    await vi.waitFor(() => expect(ollama.coupees()).toBe(1));
    // Déjà levé : rien ne part.
    await expect(ia.gemma({ prompt: "y", signal: controleur.signal })).rejects.toThrow(IA_ABANDONNEE);
    expect(ollama.requetes).toHaveLength(1);
  });

  it("kev avec un signal levé abandonne la requête vers Kev", async () => {
    const kev = garder(await fauxOllamaMuet());
    const { executer } = executeurFactice([]);
    const ia = new IaLocale({ dossier: await dossierTemporaire(), executer, kevUrl: kev.url });
    aArreter.push(ia);
    const controleur = new AbortController();
    controleur.abort();
    await expect(ia.kev({ state: "", questions: {} }, { signal: controleur.signal })).rejects.toThrow(IA_ABANDONNEE);
    expect(kev.requetes).toHaveLength(0);
  });

  it("Ollama injoignable : erreur « Ollama n'est pas lancé »", async () => {
    const { executer } = executeurFactice([]);
    const ia = new IaLocale({ dossier: await dossierTemporaire(), executer, ollamaUrl: await urlInjoignable() });
    await expect(ia.gemma({ prompt: "x" })).rejects.toThrow("Ollama n'est pas lancé");
  });

  it("Kev absent : « IA locale non installée »", async () => {
    const { executer } = executeurFactice([]);
    const ia = new IaLocale({ dossier: await dossierTemporaire(), executer, ...rapide });
    await expect(ia.kev({ state: "", questions: {} })).rejects.toThrow("IA locale non installée");
    expect(ia.etat().etat).toBe("non-installee");
  });

  it("sans kevUrl, kev() lance la commande uv pinnée dans <dossier>/kev, attend /v1/models, puis passe active", async () => {
    const dossier = await dossierTemporaire();
    await mkdir(join(dossier, "kev", ".git"), { recursive: true });
    const kev = garder(await fauxKev());
    const { executer } = executeurFactice([]);
    const lancements: { cmd: string; args: string[]; cwd: string }[] = [];
    const etats: string[] = [];
    let ia!: IaLocale;
    const lancer = (cmd: string, args: string[], o: { cwd: string }): ProcessusIa => {
      lancements.push({ cmd, args, cwd: o.cwd });
      // Kev met un peu de temps à répondre : on le branche à l'adresse du faux serveur.
      (ia as any).kevUrl = kev.url;
      return { arreter() {}, surSortie() {} };
    };
    ia = new IaLocale({ dossier, executer, lancer, port: 8123, surEtat: (e) => etats.push(e), ...rapide });
    aArreter.push(ia);
    await ia.kev({ state: "", questions: {} });
    expect(lancements).toEqual([{
      cmd: "uv",
      args: ["run", "--extra", "serve", "python", "-m", "kev.serve", "--run", "jaredpalmer/kev-4b@v1.0", "--port", "8123"],
      cwd: join(dossier, "kev"),
    }]);
    expect(etats).toEqual(["demarrage", "active"]);
    expect(ia.etat().etat).toBe("active");
  });

  it("Kev mort au démarrage : « Kev n'a pas démarré : <dernières lignes> »", async () => {
    const dossier = await dossierTemporaire();
    await mkdir(join(dossier, "kev", ".git"), { recursive: true });
    const { executer } = executeurFactice([]);
    const lancer = (): ProcessusIa => ({
      arreter() {},
      surLigne(r) { r("ligne 1"); r("boum"); },
      surSortie(r) { setTimeout(() => r(1), 5); },
    });
    const ia = new IaLocale({ dossier, executer, lancer, port: 1, ...rapide });
    await expect(ia.kev({ state: "", questions: {} })).rejects.toThrow("Kev n'a pas démarré : ligne 1\nboum");
    expect(ia.etat().etat).toBe("erreur");
  });

  it("deux appels pendant le démarrage ne lancent qu'un processus", async () => {
    const dossier = await dossierTemporaire();
    await mkdir(join(dossier, "kev", ".git"), { recursive: true });
    const kev = garder(await fauxKev());
    const { executer } = executeurFactice([]);
    let n = 0;
    let ia!: IaLocale;
    const lancer = (): ProcessusIa => {
      n++;
      setTimeout(() => { (ia as any).kevUrl = kev.url; }, 60);
      return { arreter() {}, surSortie() {} };
    };
    // port 1 : rien n'y répond (un vrai Kev peut écouter sur 8008 pendant les tests).
    ia = new IaLocale({ dossier, executer, lancer, port: 1, ...rapide });
    aArreter.push(ia);
    await Promise.all([ia.kev({ state: "a", questions: {} }), ia.kev({ state: "b", questions: {} })]);
    expect(n).toBe(1);
    expect(kev.requetes.filter((r) => r.url === "/v1/systemone")).toHaveLength(2);
  });

  it("arreter() pendant le démarrage : état arretee, sans erreur, sans minuteur", async () => {
    const dossier = await dossierTemporaire();
    await mkdir(join(dossier, "kev", ".git"), { recursive: true });
    const { executer } = executeurFactice([]);
    let sortie!: (c: number | null) => void;
    const lancer = (): ProcessusIa => ({
      arreter() { setTimeout(() => sortie(null), 1); },
      surSortie(r) { sortie = r; },
    });
    const ia = new IaLocale({ dossier, executer, lancer, port: 1, ...rapide });
    aArreter.push(ia);
    const appel = ia.kev({ state: "", questions: {} }).catch((e) => e);
    await new Promise((r) => setTimeout(r, 40));
    expect(ia.etat().etat).toBe("demarrage");
    await ia.arreter();
    await appel;
    await new Promise((r) => setTimeout(r, 40));
    expect(ia.etat()).toEqual({ etat: "arretee" });
    expect((ia as any).minuteur).toBeUndefined();
  });

  it("après 10 min sans appel, Kev est arrêté (horloge factice)", async () => {
    const dossier = await dossierTemporaire();
    await mkdir(join(dossier, "kev", ".git"), { recursive: true });
    const kev = garder(await fauxKev());
    const { executer } = executeurFactice([]);
    let maintenant = 1000;
    let arrete = 0;
    let ia!: IaLocale;
    const lancer = (): ProcessusIa => {
      (ia as any).kevUrl = kev.url;
      return { arreter() { arrete++; }, surSortie() {} };
    };
    ia = new IaLocale({ dossier, executer, lancer, horloge: () => maintenant, inactiviteMs: 600_000, ...rapide });
    aArreter.push(ia);
    await ia.kev({ state: "", questions: {} });
    expect(ia.etat().etat).toBe("active");
    maintenant += 599_000;
    await new Promise((r) => setTimeout(r, 50));
    expect(ia.etat().etat).toBe("active");
    maintenant += 2_000;
    await new Promise((r) => setTimeout(r, 50));
    expect(ia.etat().etat).toBe("arretee");
    expect(arrete).toBe(1);
  });

  it("arreter() au repos laisse relancer Kev ; fermer() refuse ensuite kev() et gemma() sans rien lancer", async () => {
    const dossier = await dossierTemporaire();
    await mkdir(join(dossier, "kev", ".git"), { recursive: true });
    const kev = garder(await fauxKev());
    const ollama = garder(await fauxOllama("ok"));
    const { executer } = executeurFactice([]);
    let lances = 0;
    let ia!: IaLocale;
    const lancer = (): ProcessusIa => {
      lances++;
      (ia as any).kevUrl = kev.url;
      return { arreter() {}, surSortie() {} };
    };
    ia = new IaLocale({ dossier, executer, lancer, ollamaUrl: ollama.url, ...rapide });
    aArreter.push(ia);
    await ia.arreter();
    await ia.kev({ state: "", questions: {} });
    expect(lances).toBe(1);
    await ia.arreter();
    await ia.kev({ state: "", questions: {} });
    expect(lances).toBe(2);
    await ia.fermer();
    expect(ia.etat().etat).toBe("arretee");
    await expect(ia.kev({ state: "", questions: {} })).rejects.toThrow("IA locale fermée");
    await expect(ia.gemma({ prompt: "x" })).rejects.toThrow("IA locale fermée");
    expect(lances).toBe(2);
    expect(ollama.requetes).toHaveLength(0);
  });

  it("accès d'un noyau : une fois fermé, il refuse et arrête Kev ; un autre accès relance Kev", async () => {
    const dossier = await dossierTemporaire();
    await mkdir(join(dossier, "kev", ".git"), { recursive: true });
    const kev = garder(await fauxKev());
    const { executer } = executeurFactice([]);
    let lances = 0;
    let arretes = 0;
    let ia!: IaLocale;
    const lancer = (): ProcessusIa => {
      lances++;
      (ia as any).kevUrl = kev.url;
      return { arreter() { arretes++; }, surSortie() {} };
    };
    ia = new IaLocale({ dossier, executer, lancer, ...rapide });
    aArreter.push(ia);
    const premier = ia.acces();
    await premier.kev({ state: "", questions: {} });
    await premier.fermer();
    expect(arretes).toBe(1);
    expect(ia.etat().etat).toBe("arretee");
    // Une récolte en retard du noyau arrêté ne relance pas Kev.
    await expect(premier.kev({ state: "", questions: {} })).rejects.toThrow("IA locale fermée");
    await expect(premier.gemma({ prompt: "x" })).rejects.toThrow("IA locale fermée");
    expect(lances).toBe(1);
    // Le noyau suivant (autre profil d'agent) a son propre accès.
    await ia.acces().kev({ state: "", questions: {} });
    expect(lances).toBe(2);
  });

  it("installer() enchaîne uv, git clone kev-1.0, uv sync, ollama pull, et reprend une installation partielle", async () => {
    const dossier = await dossierTemporaire();
    const { executer, appels } = executeurFactice([
      [/^uv --version/, { code: 0, stdout: "uv 0.5\n" }],
      [/^git clone/, clonage(dossier)],
      [/rev-parse HEAD/, { code: 0, stdout: COMMIT + "\n" }],
      [/^ollama pull/, { code: 0, stdout: "pulling…\nsuccess\n" }],
    ]);
    const ia = new IaLocale({ dossier, executer });
    const lignes: string[] = [];
    await ia.installer((l) => lignes.push(l));
    const cmds = appels.map((a) => [a.commande, ...a.args].join(" "));
    expect(cmds[0]).toBe("uv --version");
    // Cloné à côté puis renommé : un clone interrompu ne laisse jamais un `kev/.git` à moitié rempli.
    expect(cmds[1]).toBe(`git clone --depth 1 --branch kev-1.0 https://github.com/jaredpalmer/kev.git ${join(dossier, "kev.clone-en-cours")}`);
    expect(existsSync(join(dossier, "kev", ".git"))).toBe(true);
    expect(existsSync(join(dossier, "kev.clone-en-cours"))).toBe(false);
    expect(cmds.some((c) => c.includes("rev-parse HEAD"))).toBe(true);
    expect(cmds.findIndex((c) => c.startsWith("uv sync --extra serve"))).toBeGreaterThan(1);
    expect(cmds.at(-1)).toBe("ollama pull gemma4:e4b-mlx");
    expect(lignes).toContain("success");
    expect(appels.find((a) => a.args[0] === "sync")!.args).toEqual(["sync", "--extra", "serve", "--project", join(dossier, "kev")]);

    // reprise : le dépôt est déjà là, pas de nouveau clone
    const second = executeurFactice([
      [/^uv --version/, { code: 0 }],
      [/rev-parse HEAD/, { code: 0, stdout: COMMIT }],
    ]);
    await new IaLocale({ dossier, executer: second.executer }).installer(() => {});
    expect(second.appels.some((a) => a.commande === "git" && a.args[0] === "clone")).toBe(false);
    expect(second.appels.some((a) => a.args[0] === "sync")).toBe(true);
  });

  it("installer() refuse sans uv, et refuse un commit inattendu", async () => {
    const sansUv = executeurFactice([[/^uv --version/, { code: 127 }]]);
    await expect(new IaLocale({ dossier: await dossierTemporaire(), executer: sansUv.executer }).installer(() => {}))
      .rejects.toThrow("installe uv : brew install uv");
    const dossier = await dossierTemporaire();
    const mauvais = executeurFactice([[/^git clone/, clonage(dossier)], [/rev-parse HEAD/, { code: 0, stdout: "deadbeef\n" }]]);
    await expect(new IaLocale({ dossier, executer: mauvais.executer }).installer(() => {}))
      .rejects.toThrow(/commit/);
  });
});

describe("IaLocale : quitter annule l'installation", () => {
  /** git clone factice qui reste en cours (fichiers partiels écrits) jusqu'à l'annulation ; `ignorer` : sourd au signal. */
  function cloneSansFin(dossier: string, ignorer = false) {
    const recus: (AbortSignal | undefined)[] = [];
    let demarre!: () => void;
    const enCours = new Promise<void>((ok) => (demarre = ok));
    const executer: Executeur = async (commande, args, opts) => {
      if (commande === "uv" && args[0] === "--version") return { code: 0, stdout: "uv 0.5", stderr: "" };
      if (commande === "git" && args[0] === "clone") {
        recus.push(opts?.signal);
        await mkdir(join(args.at(-1)!, ".git"), { recursive: true });
        await writeFile(join(args.at(-1)!, ".git", "pack-partiel"), "à moitié");
        demarre();
        return new Promise((ok) => {
          if (!ignorer) opts?.signal?.addEventListener("abort", () => ok({ code: 143, stdout: "", stderr: "tué" }));
        });
      }
      throw new Error(`appel inattendu : ${commande} ${args.join(" ")}`);
    };
    return { executer, recus, enCours };
  }

  it("fermer() pendant le clone : le processus reçoit l'annulation, rien d'autre n'est lancé, le clone partiel est effacé, puis une nouvelle installation repart proprement", async () => {
    const dossier = await dossierTemporaire();
    const faux = cloneSansFin(dossier);
    const ia = new IaLocale({ dossier, executer: faux.executer });
    const installation = ia.installer(() => {});
    await faux.enCours;
    await ia.fermer();
    await expect(installation).rejects.toThrow("Installation annulée");
    expect(faux.recus[0]?.aborted).toBe(true);
    expect(existsSync(join(dossier, "kev"))).toBe(false);
    expect(existsSync(join(dossier, "kev.clone-en-cours"))).toBe(false);
    await expect(ia.installer(() => {})).rejects.toThrow("IA locale fermée");

    // Lancement suivant : nouvelle IaLocale, l'installation reprend depuis le début.
    const { executer, appels } = executeurFactice([
      [/^git clone/, clonage(dossier)],
      [/rev-parse HEAD/, { code: 0, stdout: COMMIT }],
    ]);
    await new IaLocale({ dossier, executer }).installer(() => {});
    expect(appels.some((a) => a.commande === "git" && a.args[0] === "clone")).toBe(true);
    expect(appels.at(-1)!.commande).toBe("ollama");
    expect(existsSync(join(dossier, "kev", ".git"))).toBe(true);
  });

  it("chaque commande de l'installation reçoit le signal d'annulation (uv sync, ollama pull)", async () => {
    const dossier = await dossierTemporaire();
    await mkdir(join(dossier, "kev", ".git"), { recursive: true });
    let pull: AbortSignal | undefined;
    const faux = executeurFactice([
      [/rev-parse HEAD/, { code: 0, stdout: COMMIT }],
    ]);
    const executer: Executeur = (c, a, o) => {
      if (c === "ollama") {
        pull = o?.signal;
        return new Promise((ok) => o?.signal?.addEventListener("abort", () => ok({ code: 143, stdout: "", stderr: "" })));
      }
      return faux.executer(c, a, o);
    };
    const ia = new IaLocale({ dossier, executer });
    const installation = ia.installer(() => {});
    while (!pull) await new Promise((r) => setTimeout(r, 5));
    expect(faux.appels.find((a) => a.args[0] === "sync")!.opts?.signal).toBe(pull);
    await ia.fermer();
    await expect(installation).rejects.toThrow("Installation annulée");
    expect(pull.aborted).toBe(true);
  });

  it("fermer() n'attend pas au-delà du délai un processus qui ignore l'annulation ; le reste du clone est effacé au lancement suivant", async () => {
    const dossier = await dossierTemporaire();
    const faux = cloneSansFin(dossier, true);
    const ia = new IaLocale({ dossier, executer: faux.executer, delaiAnnulationMs: 50 });
    void ia.installer(() => {}).catch(() => {});
    await faux.enCours;
    const debut = Date.now();
    await ia.fermer();
    expect(Date.now() - debut).toBeLessThan(1000);
    expect(existsSync(join(dossier, "kev.clone-en-cours", ".git"))).toBe(true); // le processus sourd tient encore ses fichiers

    const vuAuClone: boolean[] = [];
    const { executer } = executeurFactice([
      [/^git clone/, async () => {
        vuAuClone.push(existsSync(join(dossier, "kev.clone-en-cours")));
        return clonage(dossier)();
      }],
      [/rev-parse HEAD/, { code: 0, stdout: COMMIT }],
    ]);
    await new IaLocale({ dossier, executer }).installer(() => {});
    expect(vuAuClone).toEqual([false]); // le reste a été effacé avant de recloner
    expect(existsSync(join(dossier, "kev", ".git", "pack-partiel"))).toBe(false);
  });
});

describe("lancerProcessusIa (Kev : uv lance un enfant Python)", () => {
  const vivant = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const attendreVrai = async (f: () => boolean, ms = 5000) => {
    const fin = Date.now() + ms;
    while (!f() && Date.now() < fin) await new Promise((r) => setTimeout(r, 20));
    return f();
  };
  /** Lance `sh -c script` ; le script écrit le pid de son enfant sur la première ligne. */
  async function lancerAvecEnfant(script: string, delaiKillMs?: number) {
    const p = lancerProcessusIa("sh", ["-c", script], { cwd: process.cwd(), ...(delaiKillMs ? { delaiKillMs } : {}) });
    const pid = await new Promise<number>((ok) => p.surLigne?.((l) => ok(Number(l))));
    let sorti = false;
    p.surSortie(() => (sorti = true));
    return { p, pid, sorti: () => sorti };
  }

  it("arreter() tue aussi les enfants (tout le groupe), pas seulement le premier processus", async () => {
    const { p, pid, sorti } = await lancerAvecEnfant("sleep 300 & echo $!; wait");
    expect(vivant(pid)).toBe(true);
    p.arreter();
    expect(await attendreVrai(() => !vivant(pid))).toBe(true);
    expect(await attendreVrai(sorti)).toBe(true);
  });

  it("un groupe qui ignore SIGTERM est tué par SIGKILL après le délai", async () => {
    const { p, pid } = await lancerAvecEnfant("trap '' TERM; sleep 300 & echo $!; wait", 200);
    p.arreter();
    await new Promise((r) => setTimeout(r, 100));
    expect(vivant(pid)).toBe(true); // SIGTERM ignoré
    expect(await attendreVrai(() => !vivant(pid))).toBe(true);
  });
});
