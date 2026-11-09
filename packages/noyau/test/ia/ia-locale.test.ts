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
/** Successful fake git clone: creates the repo in the clone folder. */
const clonage = (dossier: string) => async (): Promise<Reponse> => {
  await mkdir(join(dossier, "kev.clone-en-cours", ".git"), { recursive: true });
  return { code: 0 };
};

describe("IaLocale", () => {
  it("kev() passes state and questions and returns answers", async () => {
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

  it("with modeleDecision, kev() asks Ollama's /v1/systemone with that model and launches nothing", async () => {
    const ollama = garder(await fauxKev());
    const { executer } = executeurFactice([]);
    const lancer = vi.fn();
    const ia = new IaLocale({ dossier: await dossierTemporaire(), executer, lancer, ollamaUrl: ollama.url, modeleDecision: "pplx-decider-flash" });
    aArreter.push(ia);
    const questions = { q: { type: "noul", instructions: "ok ?" } };
    expect(await ia.kev({ state: "texte", questions })).toEqual({ q: { type: "noul", noul: 0.91 } });
    const req = ollama.requetes.find((x) => x.url === "/v1/systemone")!;
    expect(req.corps).toEqual({ state: "texte", questions, model: "pplx-decider-flash" });
    expect(lancer).not.toHaveBeenCalled();
    expect(ia.etat().etat).not.toBe("non-installee");
  });

  it("an imposed Kev address wins over modeleDecision", async () => {
    const kev = garder(await fauxKev());
    const { executer } = executeurFactice([]);
    const ia = new IaLocale({ dossier: await dossierTemporaire(), executer, kevUrl: kev.url, ollamaUrl: await urlInjoignable(), modeleDecision: "pplx-decider-flash" });
    aArreter.push(ia);
    await ia.kev({ state: "texte", questions: {} });
    expect(kev.requetes.find((x) => x.url === "/v1/systemone")!.corps).toEqual({ state: "texte", questions: {} });
  });

  it("gemma() sends the gemma4:e4b-mlx model, think false, and parses the JSON if requested", async () => {
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

  it("gemma with a raised signal aborts the request to Ollama (fake server)", async () => {
    const ollama = garder(await fauxOllamaMuet());
    const { executer } = executeurFactice([]);
    const ia = new IaLocale({ dossier: await dossierTemporaire(), executer, ollamaUrl: ollama.url });
    const controleur = new AbortController();
    const appel = ia.gemma({ prompt: "x", json: true, signal: controleur.signal });
    await vi.waitFor(() => expect(ollama.requetes).toHaveLength(1));
    controleur.abort();
    await expect(appel).rejects.toThrow(IA_ABANDONNEE);
    await vi.waitFor(() => expect(ollama.coupees()).toBe(1));
    // Already raised: nothing leaves.
    await expect(ia.gemma({ prompt: "y", signal: controleur.signal })).rejects.toThrow(IA_ABANDONNEE);
    expect(ollama.requetes).toHaveLength(1);
  });

  it("kev with a raised signal aborts the request to Kev", async () => {
    const kev = garder(await fauxOllamaMuet());
    const { executer } = executeurFactice([]);
    const ia = new IaLocale({ dossier: await dossierTemporaire(), executer, kevUrl: kev.url });
    aArreter.push(ia);
    const controleur = new AbortController();
    controleur.abort();
    await expect(ia.kev({ state: "", questions: {} }, { signal: controleur.signal })).rejects.toThrow(IA_ABANDONNEE);
    expect(kev.requetes).toHaveLength(0);
  });

  it("Ollama unreachable: error « Ollama n'est pas lancé »", async () => {
    const { executer } = executeurFactice([]);
    const ia = new IaLocale({ dossier: await dossierTemporaire(), executer, ollamaUrl: await urlInjoignable() });
    await expect(ia.gemma({ prompt: "x" })).rejects.toThrow("Ollama n'est pas lancé");
  });

  it("Kev absent: « IA locale non installée »", async () => {
    const { executer } = executeurFactice([]);
    const ia = new IaLocale({ dossier: await dossierTemporaire(), executer, ...rapide });
    await expect(ia.kev({ state: "", questions: {} })).rejects.toThrow("IA locale non installée");
    expect(ia.etat().etat).toBe("non-installee");
  });

  it("without kevUrl, kev() launches the pinned uv command in <folder>/kev, waits for /v1/models, then goes active", async () => {
    const dossier = await dossierTemporaire();
    await mkdir(join(dossier, "kev", ".git"), { recursive: true });
    const kev = garder(await fauxKev());
    const { executer } = executeurFactice([]);
    const lancements: { cmd: string; args: string[]; cwd: string }[] = [];
    const etats: string[] = [];
    let ia!: IaLocale;
    const lancer = (cmd: string, args: string[], o: { cwd: string }): ProcessusIa => {
      lancements.push({ cmd, args, cwd: o.cwd });
      // Kev takes a while to answer: we plug it to the fake server's address.
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

  it("Kev dead at startup: « Kev n'a pas démarré : <last lines> »", async () => {
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

  it("two calls during startup launch only one process", async () => {
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
    // port 1: nothing answers there (a real Kev may listen on 8008 during the tests).
    ia = new IaLocale({ dossier, executer, lancer, port: 1, ...rapide });
    aArreter.push(ia);
    await Promise.all([ia.kev({ state: "a", questions: {} }), ia.kev({ state: "b", questions: {} })]);
    expect(n).toBe(1);
    expect(kev.requetes.filter((r) => r.url === "/v1/systemone")).toHaveLength(2);
  });

  it("arreter() during startup: state arretee, no error, no timer", async () => {
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

  it("after 10 min without a call, Kev is stopped (fake clock)", async () => {
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

  it("arreter() at rest lets Kev be relaunched; fermer() then refuses kev() and gemma() without launching anything", async () => {
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

  it("a core's access: once closed, it refuses and stops Kev; another access relaunches Kev", async () => {
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
    // A late harvest of the stopped core does not relaunch Kev.
    await expect(premier.kev({ state: "", questions: {} })).rejects.toThrow("IA locale fermée");
    await expect(premier.gemma({ prompt: "x" })).rejects.toThrow("IA locale fermée");
    expect(lances).toBe(1);
    // The next core (other agent profile) has its own access.
    await ia.acces().kev({ state: "", questions: {} });
    expect(lances).toBe(2);
  });

  it("installer() chains uv, git clone kev-1.0, uv sync, ollama pull, and resumes a partial install", async () => {
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
    // Cloned alongside then renamed: an interrupted clone never leaves a half-filled `kev/.git`.
    expect(cmds[1]).toBe(`git clone --depth 1 --branch kev-1.0 https://github.com/jaredpalmer/kev.git ${join(dossier, "kev.clone-en-cours")}`);
    expect(existsSync(join(dossier, "kev", ".git"))).toBe(true);
    expect(existsSync(join(dossier, "kev.clone-en-cours"))).toBe(false);
    expect(cmds.some((c) => c.includes("rev-parse HEAD"))).toBe(true);
    expect(cmds.findIndex((c) => c.startsWith("uv sync --extra serve"))).toBeGreaterThan(1);
    expect(cmds.at(-1)).toBe("ollama pull gemma4:e4b-mlx");
    expect(lignes).toContain("success");
    expect(appels.find((a) => a.args[0] === "sync")!.args).toEqual(["sync", "--extra", "serve", "--project", join(dossier, "kev")]);

    // resume: the repo is already there, no new clone
    const second = executeurFactice([
      [/^uv --version/, { code: 0 }],
      [/rev-parse HEAD/, { code: 0, stdout: COMMIT }],
    ]);
    await new IaLocale({ dossier, executer: second.executer }).installer(() => {});
    expect(second.appels.some((a) => a.commande === "git" && a.args[0] === "clone")).toBe(false);
    expect(second.appels.some((a) => a.args[0] === "sync")).toBe(true);
  });

  it("installer() refuses without uv, and refuses an unexpected commit", async () => {
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
  /** Fake git clone that stays in progress (partial files written) until cancellation; `ignorer`: deaf to the signal. */
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

  it("fermer() during the clone: the process receives the cancellation, nothing else is launched, the partial clone is erased, then a new install restarts cleanly", async () => {
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

    // Next launch: new IaLocale, the install restarts from the beginning.
    const { executer, appels } = executeurFactice([
      [/^git clone/, clonage(dossier)],
      [/rev-parse HEAD/, { code: 0, stdout: COMMIT }],
    ]);
    await new IaLocale({ dossier, executer }).installer(() => {});
    expect(appels.some((a) => a.commande === "git" && a.args[0] === "clone")).toBe(true);
    expect(appels.at(-1)!.commande).toBe("ollama");
    expect(existsSync(join(dossier, "kev", ".git"))).toBe(true);
  });

  it("each install command receives the cancellation signal (uv sync, ollama pull)", async () => {
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

  it("fermer() does not wait beyond the delay for a process that ignores the cancellation; the rest of the clone is erased at the next launch", async () => {
    const dossier = await dossierTemporaire();
    const faux = cloneSansFin(dossier, true);
    const ia = new IaLocale({ dossier, executer: faux.executer, delaiAnnulationMs: 50 });
    void ia.installer(() => {}).catch(() => {});
    await faux.enCours;
    const debut = Date.now();
    await ia.fermer();
    expect(Date.now() - debut).toBeLessThan(1000);
    expect(existsSync(join(dossier, "kev.clone-en-cours", ".git"))).toBe(true); // the deaf process still holds its files

    const vuAuClone: boolean[] = [];
    const { executer } = executeurFactice([
      [/^git clone/, async () => {
        vuAuClone.push(existsSync(join(dossier, "kev.clone-en-cours")));
        return clonage(dossier)();
      }],
      [/rev-parse HEAD/, { code: 0, stdout: COMMIT }],
    ]);
    await new IaLocale({ dossier, executer }).installer(() => {});
    expect(vuAuClone).toEqual([false]); // the rest was erased before recloning
    expect(existsSync(join(dossier, "kev", ".git", "pack-partiel"))).toBe(false);
  });
});

describe("lancerProcessusIa (Kev: uv launches a Python child)", () => {
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
  /** Launches `sh -c script`; the script writes its child's pid on the first line. */
  async function lancerAvecEnfant(script: string, delaiKillMs?: number) {
    const p = lancerProcessusIa("sh", ["-c", script], { cwd: process.cwd(), ...(delaiKillMs ? { delaiKillMs } : {}) });
    const pid = await new Promise<number>((ok) => p.surLigne?.((l) => ok(Number(l))));
    let sorti = false;
    p.surSortie(() => (sorti = true));
    return { p, pid, sorti: () => sorti };
  }

  it("arreter() also kills the children (the whole group), not only the first process", async () => {
    const { p, pid, sorti } = await lancerAvecEnfant("sleep 300 & echo $!; wait");
    expect(vivant(pid)).toBe(true);
    p.arreter();
    expect(await attendreVrai(() => !vivant(pid))).toBe(true);
    expect(await attendreVrai(sorti)).toBe(true);
  });

  it("a group that ignores SIGTERM is killed by SIGKILL after the delay", async () => {
    const { p, pid } = await lancerAvecEnfant("trap '' TERM; sleep 300 & echo $!; wait", 200);
    p.arreter();
    await new Promise((r) => setTimeout(r, 100));
    expect(vivant(pid)).toBe(true); // SIGTERM ignored
    expect(await attendreVrai(() => !vivant(pid))).toBe(true);
  });
});
