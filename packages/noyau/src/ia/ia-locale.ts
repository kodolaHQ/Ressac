import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { cheminOutils, oublierGroupe, retenirGroupe, tuerGroupe, type Executeur } from "../conteneur/executeur.js";
import { GEMMA_JSON_INVALIDE, IA_ABANDONNEE } from "./repartiteur.js";

export type EtatIa = "non-installee" | "arretee" | "demarrage" | "active" | "erreur";

export interface ProcessusIa {
  arreter(): void;
  surSortie(rappel: (code: number | null) => void): void;
  /** Optional: receives each output line (stdout and stderr), for error messages. */
  surLigne?(rappel: (ligne: string) => void): void;
}

export interface OptionsIaLocale {
  /** `<browser profile>/ia-locale`; Kev is cloned there in `kev/`. */
  dossier: string;
  executer: Executeur;
  lancer?: (cmd: string, args: string[], o: { cwd: string }) => ProcessusIa;
  kevUrl?: string;
  ollamaUrl?: string;
  /** Ollama decision model (same /v1/systemone API as Kev) used instead of launching Kev; an imposed Kev address wins. */
  modeleDecision?: string;
  port?: number;
  inactiviteMs?: number;
  horloge?: () => number;
  surEtat?: (e: EtatIa, erreur?: string) => void;
  /** Polling interval of /v1/models at startup (500 ms by default). */
  sondageMs?: number;
  /** Inactivity check interval (5 s by default). */
  verifInactiviteMs?: number;
  /** Maximum wait, at close, for a cancelled install to finish (3 s by default). */
  delaiAnnulationMs?: number;
}

export const DEPOT_KEV = "https://github.com/jaredpalmer/kev.git";
export const TAG_KEV = "kev-1.0";
export const COMMIT_KEV = "6b719c3c3f367295f6ef336f4f751cf5ff970abc";
export const MODELE_KEV = "jaredpalmer/kev-4b@v1.0";
export const MODELE_GEMMA = "gemma4:e4b-mlx";
const DELAI_DEMARRAGE_MS = 180_000;
const DELAI_KEV_MS = 60_000;
const DELAI_GEMMA_MS = 120_000;

/** Delay between SIGTERM and SIGKILL when Kev (its group) does not stop. */
const DELAI_KILL_MS = 5000;

/**
 * Launches the command in its own process group (`uv run` launches a Python child: killing uv alone would leave it
 * orphaned). `arreter` sends SIGTERM to the group, then SIGKILL after `delaiKillMs` if it is still alive. If the Node process
 * exits without stopping the group, it is killed at exit.
 */
export function lancerProcessusIa(cmd: string, args: string[], o: { cwd: string; delaiKillMs?: number }): ProcessusIa {
  const enfant = spawn(cmd, args, { cwd: o.cwd, env: { ...process.env, PATH: cheminOutils() }, stdio: ["ignore", "pipe", "pipe"], detached: true });
  const pid = enfant.pid;
  if (pid !== undefined) retenirGroupe(pid);
  let sorti = false;
  enfant.on("exit", () => {
    sorti = true;
    if (pid !== undefined && !tuerGroupe(pid, 0)) oublierGroupe(pid);
  });
  return {
    arreter: () => {
      if (pid === undefined) return;
      if (!tuerGroupe(pid, "SIGTERM")) {
        oublierGroupe(pid);
        return;
      }
      // The group may outlive the first process (a child that ignores SIGTERM): we check the group, not `sorti`.
      const minuterie = setTimeout(() => {
        tuerGroupe(pid, "SIGKILL");
        oublierGroupe(pid);
      }, o.delaiKillMs ?? DELAI_KILL_MS);
      minuterie.unref();
      const verifier = setInterval(() => {
        if (sorti && !tuerGroupe(pid, 0)) {
          clearTimeout(minuterie);
          clearInterval(verifier);
          oublierGroupe(pid);
        }
      }, 100);
      verifier.unref();
    },
    surSortie: (r) => {
      enfant.on("exit", (code) => r(code));
      enfant.on("error", () => r(127));
    },
    surLigne: (r) => {
      for (const flux of [enfant.stdout, enfant.stderr]) {
        let reste = "";
        flux.on("data", (d: Buffer) => {
          const morceaux = (reste + d.toString("utf8")).split(/\r?\n/);
          reste = morceaux.pop() ?? "";
          morceaux.forEach((l) => l && r(l));
        });
      }
    },
  };
}

const lancerParDefaut: NonNullable<OptionsIaLocale["lancer"]> = (cmd, args, o) => lancerProcessusIa(cmd, args, o);

/** The call's timeout, and the caller's signal if there is one. */
const delaiEt = (ms: number, signal?: AbortSignal) => (signal ? AbortSignal.any([AbortSignal.timeout(ms), signal]) : AbortSignal.timeout(ms));
/** The caller's signal is raised: the call is abandoned (otherwise the original error). */
const verifierAbandon = (signal?: AbortSignal) => {
  if (signal?.aborted) throw new Error(IA_ABANDONNEE);
};

const attendre = (ms: number) => new Promise<void>((ok) => setTimeout(ok, ms));

export const ERREUR_IA_FERMEE = "IA locale fermée";
export const ERREUR_INSTALLATION_ANNULEE = "Installation annulée";
/** Maximum wait for a cancelled install to finish when the app quits. */
const DELAI_ANNULATION_MS = 3000;

/**
 * Local AI as seen by a kernel. Once `fermer()` is called (kernel shutdown), its calls are refused: a late
 * harvest does not relaunch Kev. The next kernel (another agent profile) gets a new access.
 */
export interface AccesIa {
  kev: IaLocale["kev"];
  gemma: IaLocale["gemma"];
  fermer(): Promise<void>;
}

export class IaLocale {
  private etatCourant: EtatIa = "arretee";
  private erreurCourante?: string;
  private processus?: ProcessusIa;
  private demarrage?: Promise<void>;
  private minuteur?: NodeJS.Timeout;
  private dernierUsage = 0;
  private generation = 0;
  /** Closed (the browser quits): nothing starts Kev or calls Ollama anymore. */
  private fermee = false;
  /** Install in progress: its cancellation and its end (successful or not). */
  private installation?: { controleur: AbortController; fin: Promise<unknown> };
  // Modifiable: Kev's address, imposed by WEBAIOS_KEV_URL or computed from the port.
  private kevUrl: string;
  private readonly kevImposee: boolean;
  private readonly ollamaUrl: string;
  private readonly port: number;
  private readonly inactiviteMs: number;
  private readonly horloge: () => number;
  private readonly lancer: NonNullable<OptionsIaLocale["lancer"]>;

  constructor(private readonly o: OptionsIaLocale) {
    this.port = o.port ?? 8008;
    const imposee = o.kevUrl ?? process.env.WEBAIOS_KEV_URL;
    this.kevImposee = Boolean(imposee);
    this.kevUrl = imposee ?? `http://127.0.0.1:${this.port}`;
    this.ollamaUrl = o.ollamaUrl ?? process.env.WEBAIOS_OLLAMA_URL ?? "http://127.0.0.1:11434";
    this.inactiviteMs = o.inactiviteMs ?? 600_000;
    this.horloge = o.horloge ?? Date.now;
    this.lancer = o.lancer ?? lancerParDefaut;
  }

  etat(): { etat: EtatIa; erreur?: string } {
    return this.erreurCourante ? { etat: this.etatCourant, erreur: this.erreurCourante } : { etat: this.etatCourant };
  }

  private changer(e: EtatIa, erreur?: string) {
    this.etatCourant = e;
    this.erreurCourante = erreur;
    this.o.surEtat?.(e, erreur);
  }

  private get dossierKev() { return join(this.o.dossier, "kev"); }

  async verifier(): Promise<{ kev: boolean; uv: boolean; ollama: boolean; gemma: boolean }> {
    const kev = existsSync(join(this.dossierKev, ".git"));
    const uv = (await this.o.executer("uv", ["--version"], { delaiMs: 10_000 })).code === 0;
    let ollama = false;
    let gemma = false;
    try {
      const r = await fetch(`${this.ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
      ollama = r.ok;
      if (r.ok) {
        const { models } = (await r.json()) as { models?: { name?: string }[] };
        gemma = (models ?? []).some((m) => m.name === MODELE_GEMMA);
      }
    } catch { /* unreachable */ }
    return { kev, uv, ollama, gemma };
  }

  /** Folder where Kev is cloned before being renamed to `kev/`: an interrupted clone never leaves a partial repo there. */
  private get dossierClone() { return join(this.o.dossier, "kev.clone-en-cours"); }

  /**
   * Installs Kev and Gemma. Cancelled by `annulerInstallation()` or `fermer()`: the current command is killed (its whole
   * group), none follows, a partial clone is erased, and the promise is rejected « Installation annulée ».
   */
  installer(progres: (ligne: string) => void): Promise<void> {
    if (this.fermee) return Promise.reject(new Error(ERREUR_IA_FERMEE));
    if (this.installation) return Promise.reject(new Error("Installation déjà en cours"));
    const controleur = new AbortController();
    const fin = this.installerAvec(controleur.signal, progres).finally(() => {
      if (this.installation?.controleur === controleur) this.installation = undefined;
    });
    this.installation = { controleur, fin: fin.catch(() => {}) };
    return fin;
  }

  /** Cancels the install in progress, if there is one (without waiting for its end). */
  annulerInstallation(): void {
    this.installation?.controleur.abort();
  }

  private async installerAvec(signal: AbortSignal, progres: (ligne: string) => void): Promise<void> {
    const verifierAnnulation = () => {
      if (signal.aborted) throw new Error(ERREUR_INSTALLATION_ANNULEE);
    };
    const executer = async (cmd: string, args: string[], delaiMs?: number) => {
      verifierAnnulation();
      const r = await this.o.executer(cmd, args, delaiMs ? { delaiMs, signal } : { signal });
      verifierAnnulation();
      return r;
    };
    const lancer = async (cmd: string, args: string[], delaiMs?: number) => {
      verifierAnnulation();
      progres(`$ ${[cmd, ...args].join(" ")}`);
      const r = await executer(cmd, args, delaiMs);
      for (const l of `${r.stdout}\n${r.stderr}`.split(/\r?\n/)) if (l.trim()) progres(l);
      return r;
    };
    // 1. uv
    if ((await lancer("uv", ["--version"], 10_000)).code !== 0) throw new Error("installe uv : brew install uv");
    // 2. Kev repo at the pinned commit, cloned aside then renamed. The clone folder belongs only to this code: what is left
    // of an interrupted clone (app killed before it could erase it) is erased before recloning.
    if (!existsSync(join(this.dossierKev, ".git"))) {
      await rm(this.dossierClone, { recursive: true, force: true });
      try {
        const r = await lancer("git", ["clone", "--depth", "1", "--branch", TAG_KEV, DEPOT_KEV, this.dossierClone]);
        if (r.code !== 0) throw new Error(`git clone a échoué : ${r.stderr.trim()}`);
        await rename(this.dossierClone, this.dossierKev);
      } catch (e) {
        await rm(this.dossierClone, { recursive: true, force: true }).catch(() => {});
        throw e;
      }
    }
    const tete = await executer("git", ["-C", this.dossierKev, "rev-parse", "HEAD"]);
    if (tete.code !== 0 || tete.stdout.trim() !== COMMIT_KEV) {
      throw new Error(`Le commit de Kev n'est pas celui attendu (${COMMIT_KEV}) : ${tete.stdout.trim() || tete.stderr.trim()}`);
    }
    // 3. dependencies (an interrupted sync is resumed by the next one, or by `uv run` at Kev's start)
    const sync = await lancer("uv", ["sync", "--extra", "serve", "--project", this.dossierKev]);
    if (sync.code !== 0) throw new Error(`uv sync a échoué : ${sync.stderr.trim()}`);
    // 4. Gemma model. Killing `ollama pull` cuts its request to the Ollama server, which stops the download and keeps its
    // chunks for resuming: they are Ollama's (shared with the user), we do not touch them.
    const tire = await lancer("ollama", ["pull", MODELE_GEMMA]);
    if (tire.code !== 0) throw new Error(`ollama pull a échoué : ${tire.stderr.trim()}`);
  }

  async kev(corps: { state: unknown; questions: Record<string, unknown> }, o: { signal?: AbortSignal } = {}): Promise<unknown> {
    if (this.fermee) throw new Error(ERREUR_IA_FERMEE);
    verifierAbandon(o.signal);
    const modele = this.kevImposee ? undefined : this.o.modeleDecision;
    if (!modele) await this.assurerKev();
    verifierAbandon(o.signal);
    this.dernierUsage = this.horloge();
    let r: Response;
    try {
      r = await fetch(`${modele ? this.ollamaUrl : this.kevUrl}/v1/systemone`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(modele ? { ...corps, model: modele } : corps),
        signal: delaiEt(DELAI_KEV_MS, o.signal),
      });
    } catch (e) {
      verifierAbandon(o.signal);
      throw new Error(`Kev ne répond pas : ${(e as Error).message}`);
    }
    if (!r.ok) throw new Error(`Kev a répondu ${r.status}`);
    this.dernierUsage = this.horloge();
    try {
      return ((await r.json()) as { answers: unknown }).answers;
    } catch (e) {
      verifierAbandon(o.signal);
      throw e;
    }
  }

  async gemma(o: { prompt: string; images?: string[]; json?: boolean; signal?: AbortSignal }): Promise<string | unknown> {
    if (this.fermee) throw new Error(ERREUR_IA_FERMEE);
    verifierAbandon(o.signal);
    const message: Record<string, unknown> = { role: "user", content: o.prompt };
    if (o.images?.length) message.images = o.images;
    const corps: Record<string, unknown> = {
      model: MODELE_GEMMA,
      messages: [message],
      stream: false,
      think: false,
      keep_alive: "10m",
      options: { num_ctx: 16384, temperature: 0.2 },
    };
    if (o.json) corps.format = "json";
    let r: Response;
    try {
      r = await fetch(`${this.ollamaUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(corps),
        signal: delaiEt(DELAI_GEMMA_MS, o.signal),
      });
    } catch {
      verifierAbandon(o.signal);
      throw new Error("Ollama n'est pas lancé");
    }
    if (!r.ok) throw new Error(`Ollama a répondu ${r.status}`);
    let reponse: { message?: { content?: string } };
    try {
      reponse = (await r.json()) as { message?: { content?: string } };
    } catch (e) {
      verifierAbandon(o.signal);
      throw e;
    }
    const contenu = reponse.message?.content ?? "";
    if (!o.json) return contenu;
    try {
      return JSON.parse(contenu);
    } catch {
      throw new Error(GEMMA_JSON_INVALIDE);
    }
  }

  /** Stops Kev for good: kev() and gemma() are refused afterwards (arreter(), on the other hand, allows a relaunch). */
  async fermer(): Promise<void> {
    this.fermee = true;
    const installation = this.installation;
    if (installation) {
      // The app quits: the install is cancelled; its cleanup is awaited, but never longer than the delay.
      installation.controleur.abort();
      let minuterie: NodeJS.Timeout | undefined;
      const delai = new Promise<void>((ok) => (minuterie = setTimeout(ok, this.o.delaiAnnulationMs ?? DELAI_ANNULATION_MS)));
      await Promise.race([installation.fin, delai]);
      clearTimeout(minuterie);
    }
    await this.arreter();
  }

  /** An access for a kernel, closed with it (see AccesIa). */
  acces(): AccesIa {
    let ferme = false;
    // Checked before the call: kev() launches Kev synchronously, before its first await; fermer() stops it afterwards.
    return {
      kev: (corps, o) => (ferme ? Promise.reject(new Error(ERREUR_IA_FERMEE)) : this.kev(corps, o)),
      gemma: (o) => (ferme ? Promise.reject(new Error(ERREUR_IA_FERMEE)) : this.gemma(o)),
      fermer: async () => {
        ferme = true;
        await this.arreter();
      },
    };
  }

  async arreter(): Promise<void> {
    if (this.minuteur) clearInterval(this.minuteur);
    this.minuteur = undefined;
    const p = this.processus;
    this.processus = undefined;
    this.demarrage = undefined;
    this.generation++;
    p?.arreter();
    if (this.etatCourant === "active" || this.etatCourant === "demarrage") this.changer("arretee");
  }

  private assurerKev(): Promise<void> {
    if (this.etatCourant === "active") return Promise.resolve();
    if (!this.demarrage) {
      const d = this.demarrerKev().finally(() => { if (this.demarrage === d) this.demarrage = undefined; });
      this.demarrage = d;
    }
    return this.demarrage;
  }

  private async demarrerKev(): Promise<void> {
    if (this.kevImposee) {
      this.changer("active");
      return;
    }
    if (!existsSync(join(this.dossierKev, ".git"))) {
      this.changer("non-installee");
      throw new Error("IA locale non installée");
    }
    const gen = ++this.generation;
    this.changer("demarrage");
    const lignes: string[] = [];
    let sortie: number | null | undefined;
    const p = this.lancer("uv", ["run", "--extra", "serve", "python", "-m", "kev.serve", "--run", MODELE_KEV, "--port", String(this.port)], { cwd: this.dossierKev });
    this.processus = p;
    p.surLigne?.((l) => { lignes.push(l); if (lignes.length > 20) lignes.shift(); });
    let mort = false;
    p.surSortie((code) => {
      mort = true;
      sortie = code;
      if (this.processus === p) { this.processus = undefined; if (this.etatCourant === "active") this.changer("arretee"); }
    });
    const pas = this.o.sondageMs ?? 500;
    const fin = Date.now() + DELAI_DEMARRAGE_MS;
    while (Date.now() < fin) {
      if (gen !== this.generation) return; // arreter() came through here
      if (mort) {
        const msg = `Kev n'a pas démarré : ${lignes.slice(-5).join("\n") || `code ${sortie}`}`;
        this.changer("erreur", msg);
        throw new Error(msg);
      }
      try {
        const r = await fetch(`${this.kevUrl}/v1/models`, { signal: AbortSignal.timeout(2000) });
        if (gen !== this.generation) return;
        if (r.ok) {
          this.dernierUsage = this.horloge();
          this.changer("active");
          this.surveillerInactivite();
          return;
        }
      } catch { /* not ready yet */ }
      await attendre(pas);
    }
    if (gen !== this.generation) return;
    p.arreter();
    this.processus = undefined;
    const msg = `Kev n'a pas démarré : délai dépassé. ${lignes.slice(-5).join("\n")}`.trim();
    this.changer("erreur", msg);
    throw new Error(msg);
  }

  private surveillerInactivite() {
    if (this.minuteur) clearInterval(this.minuteur);
    this.minuteur = setInterval(() => {
      if (this.horloge() - this.dernierUsage >= this.inactiviteMs) void this.arreter();
    }, this.o.verifInactiviteMs ?? 5000);
    this.minuteur.unref();
  }
}
