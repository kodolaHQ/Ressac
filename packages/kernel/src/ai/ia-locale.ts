import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { toolsPath, forgetGroup, keepGroup, killGroup, type Runner } from "../container/runner.js";
import { GEMMA_JSON_INVALID, AI_ABANDONED } from "./dispatcher.js";

export type AiState = "non-installee" | "arretee" | "demarrage" | "active" | "erreur";

export interface AiProcess {
  arreter(): void;
  surSortie(rappel: (code: number | null) => void): void;
  /** Optional: receives each output line (stdout and stderr), for error messages. */
  surLigne?(rappel: (ligne: string) => void): void;
}

export interface OptionsIaLocale {
  /** `<browser profile>/ia-locale`; Kev is cloned there in `kev/`. */
  dossier: string;
  executer: Runner;
  lancer?: (cmd: string, args: string[], o: { cwd: string }) => AiProcess;
  kevUrl?: string;
  ollamaUrl?: string;
  /** Ollama decision model (same /v1/systemone API as Kev) used instead of launching Kev; an imposed Kev address wins. */
  modeleDecision?: string;
  port?: number;
  inactiviteMs?: number;
  horloge?: () => number;
  surEtat?: (e: AiState, error?: string) => void;
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
export const KEV_MODEL = "jaredpalmer/kev-4b@v1.0";
export const GEMMA_MODEL = "gemma4:e4b-mlx";
const STARTUP_DELAY_MS = 180_000;
const KEV_DELAY_MS = 60_000;
const GEMMA_DELAY_MS = 120_000;

/** Delay between SIGTERM and SIGKILL when Kev (its group) does not stop. */
const KILL_DELAY_MS = 5000;

/**
 * Launches the command in its own process group (`uv run` launches a Python child: killing uv alone would leave it
 * orphaned). `arreter` sends SIGTERM to the group, then SIGKILL after `delaiKillMs` if it is still alive. If the Node process
 * exits without stopping the group, it is killed at exit.
 */
export function launchAiProcess(cmd: string, args: string[], o: { cwd: string; delaiKillMs?: number }): AiProcess {
  const child = spawn(cmd, args, { cwd: o.cwd, env: { ...process.env, PATH: toolsPath() }, stdio: ["ignore", "pipe", "pipe"], detached: true });
  const pid = child.pid;
  if (pid !== undefined) keepGroup(pid);
  let exited = false;
  child.on("exit", () => {
    exited = true;
    if (pid !== undefined && !killGroup(pid, 0)) forgetGroup(pid);
  });
  return {
    arreter: () => {
      if (pid === undefined) return;
      if (!killGroup(pid, "SIGTERM")) {
        forgetGroup(pid);
        return;
      }
      // The group may outlive the first process (a child that ignores SIGTERM): we check the group, not `sorti`.
      const timer = setTimeout(() => {
        killGroup(pid, "SIGKILL");
        forgetGroup(pid);
      }, o.delaiKillMs ?? KILL_DELAY_MS);
      timer.unref();
      const verifier = setInterval(() => {
        if (exited && !killGroup(pid, 0)) {
          clearTimeout(timer);
          clearInterval(verifier);
          forgetGroup(pid);
        }
      }, 100);
      verifier.unref();
    },
    surSortie: (r) => {
      child.on("exit", (code) => r(code));
      child.on("error", () => r(127));
    },
    surLigne: (r) => {
      for (const flux of [child.stdout, child.stderr]) {
        let rest = "";
        flux.on("data", (d: Buffer) => {
          const chunks = (rest + d.toString("utf8")).split(/\r?\n/);
          rest = chunks.pop() ?? "";
          chunks.forEach((l) => l && r(l));
        });
      }
    },
  };
}

const defaultLaunch: NonNullable<OptionsIaLocale["lancer"]> = (cmd, args, o) => launchAiProcess(cmd, args, o);

/** The call's timeout, and the caller's signal if there is one. */
const delayAnd = (ms: number, signal?: AbortSignal) => (signal ? AbortSignal.any([AbortSignal.timeout(ms), signal]) : AbortSignal.timeout(ms));
/** The caller's signal is raised: the call is abandoned (otherwise the original error). */
const verifierAbandon = (signal?: AbortSignal) => {
  if (signal?.aborted) throw new Error(AI_ABANDONED);
};

const wait = (ms: number) => new Promise<void>((ok) => setTimeout(ok, ms));

export const AI_CLOSED_ERROR = "IA locale fermée";
export const INSTALL_CANCELLED_ERROR = "Installation annulée";
/** Maximum wait for a cancelled install to finish when the app quits. */
const CANCEL_DELAY_MS = 3000;

/**
 * Local AI as seen by a kernel. Once `fermer()` is called (kernel shutdown), its calls are refused: a late
 * harvest does not relaunch Kev. The next kernel (another agent profile) gets a new access.
 */
export interface AiAccess {
  kev: IaLocale["kev"];
  gemma: IaLocale["gemma"];
  fermer(): Promise<void>;
}

export class IaLocale {
  private etatCourant: AiState = "arretee";
  private erreurCourante?: string;
  private processus?: AiProcess;
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
    const imposed = o.kevUrl ?? process.env.WEBAIOS_KEV_URL;
    this.kevImposee = Boolean(imposed);
    this.kevUrl = imposed ?? `http://127.0.0.1:${this.port}`;
    this.ollamaUrl = o.ollamaUrl ?? process.env.WEBAIOS_OLLAMA_URL ?? "http://127.0.0.1:11434";
    this.inactiviteMs = o.inactiviteMs ?? 600_000;
    this.horloge = o.horloge ?? Date.now;
    this.lancer = o.lancer ?? defaultLaunch;
  }

  etat(): { etat: AiState; erreur?: string } {
    return this.erreurCourante ? { etat: this.etatCourant, erreur: this.erreurCourante } : { etat: this.etatCourant };
  }

  private changer(e: AiState, error?: string) {
    this.etatCourant = e;
    this.erreurCourante = error;
    this.o.surEtat?.(e, error);
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
        gemma = (models ?? []).some((m) => m.name === GEMMA_MODEL);
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
  installer(progress: (ligne: string) => void): Promise<void> {
    if (this.fermee) return Promise.reject(new Error(AI_CLOSED_ERROR));
    if (this.installation) return Promise.reject(new Error("Installation déjà en cours"));
    const controller = new AbortController();
    const fin = this.installerAvec(controller.signal, progress).finally(() => {
      if (this.installation?.controleur === controller) this.installation = undefined;
    });
    this.installation = { controleur: controller, fin: fin.catch(() => {}) };
    return fin;
  }

  /** Cancels the install in progress, if there is one (without waiting for its end). */
  annulerInstallation(): void {
    this.installation?.controleur.abort();
  }

  private async installerAvec(signal: AbortSignal, progress: (ligne: string) => void): Promise<void> {
    const verifierAnnulation = () => {
      if (signal.aborted) throw new Error(INSTALL_CANCELLED_ERROR);
    };
    const executer = async (cmd: string, args: string[], delayMs?: number) => {
      verifierAnnulation();
      const r = await this.o.executer(cmd, args, delayMs ? { delaiMs: delayMs, signal } : { signal });
      verifierAnnulation();
      return r;
    };
    const lancer = async (cmd: string, args: string[], delayMs?: number) => {
      verifierAnnulation();
      progress(`$ ${[cmd, ...args].join(" ")}`);
      const r = await executer(cmd, args, delayMs);
      for (const l of `${r.stdout}\n${r.stderr}`.split(/\r?\n/)) if (l.trim()) progress(l);
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
    const tire = await lancer("ollama", ["pull", GEMMA_MODEL]);
    if (tire.code !== 0) throw new Error(`ollama pull a échoué : ${tire.stderr.trim()}`);
  }

  async kev(corps: { state: unknown; questions: Record<string, unknown> }, o: { signal?: AbortSignal } = {}): Promise<unknown> {
    if (this.fermee) throw new Error(AI_CLOSED_ERROR);
    verifierAbandon(o.signal);
    const model = this.kevImposee ? undefined : this.o.modeleDecision;
    if (!model) await this.assurerKev();
    verifierAbandon(o.signal);
    this.dernierUsage = this.horloge();
    let r: Response;
    try {
      r = await fetch(`${model ? this.ollamaUrl : this.kevUrl}/v1/systemone`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(model ? { ...corps, model: model } : corps),
        signal: delayAnd(KEV_DELAY_MS, o.signal),
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
    if (this.fermee) throw new Error(AI_CLOSED_ERROR);
    verifierAbandon(o.signal);
    const message: Record<string, unknown> = { role: "user", content: o.prompt };
    if (o.images?.length) message.images = o.images;
    const corps: Record<string, unknown> = {
      model: GEMMA_MODEL,
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
        signal: delayAnd(GEMMA_DELAY_MS, o.signal),
      });
    } catch {
      verifierAbandon(o.signal);
      throw new Error("Ollama n'est pas lancé");
    }
    if (!r.ok) throw new Error(`Ollama a répondu ${r.status}`);
    let response: { message?: { content?: string } };
    try {
      response = (await r.json()) as { message?: { content?: string } };
    } catch (e) {
      verifierAbandon(o.signal);
      throw e;
    }
    const content = response.message?.content ?? "";
    if (!o.json) return content;
    try {
      return JSON.parse(content);
    } catch {
      throw new Error(GEMMA_JSON_INVALID);
    }
  }

  /** Stops Kev for good: kev() and gemma() are refused afterwards (arreter(), on the other hand, allows a relaunch). */
  async fermer(): Promise<void> {
    this.fermee = true;
    const installation = this.installation;
    if (installation) {
      // The app quits: the install is cancelled; its cleanup is awaited, but never longer than the delay.
      installation.controleur.abort();
      let timer: NodeJS.Timeout | undefined;
      const delay = new Promise<void>((ok) => (timer = setTimeout(ok, this.o.delaiAnnulationMs ?? CANCEL_DELAY_MS)));
      await Promise.race([installation.fin, delay]);
      clearTimeout(timer);
    }
    await this.arreter();
  }

  /** An access for a kernel, closed with it (see AccesIa). */
  acces(): AiAccess {
    let ferme = false;
    // Checked before the call: kev() launches Kev synchronously, before its first await; fermer() stops it afterwards.
    return {
      kev: (corps, o) => (ferme ? Promise.reject(new Error(AI_CLOSED_ERROR)) : this.kev(corps, o)),
      gemma: (o) => (ferme ? Promise.reject(new Error(AI_CLOSED_ERROR)) : this.gemma(o)),
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
    const p = this.lancer("uv", ["run", "--extra", "serve", "python", "-m", "kev.serve", "--run", KEV_MODEL, "--port", String(this.port)], { cwd: this.dossierKev });
    this.processus = p;
    p.surLigne?.((l) => { lignes.push(l); if (lignes.length > 20) lignes.shift(); });
    let mort = false;
    p.surSortie((code) => {
      mort = true;
      sortie = code;
      if (this.processus === p) { this.processus = undefined; if (this.etatCourant === "active") this.changer("arretee"); }
    });
    const pas = this.o.sondageMs ?? 500;
    const fin = Date.now() + STARTUP_DELAY_MS;
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
      await wait(pas);
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
