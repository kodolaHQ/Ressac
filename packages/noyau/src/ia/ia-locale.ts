import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { cheminOutils, type Executeur } from "../conteneur/executeur.js";

export type EtatIa = "non-installee" | "arretee" | "demarrage" | "active" | "erreur";

export interface ProcessusIa {
  arreter(): void;
  surSortie(rappel: (code: number | null) => void): void;
  /** Facultatif : reçoit chaque ligne de sortie (stdout et stderr), pour les messages d'erreur. */
  surLigne?(rappel: (ligne: string) => void): void;
}

export interface OptionsIaLocale {
  /** `<profil du navigateur>/ia-locale` ; Kev y est cloné dans `kev/`. */
  dossier: string;
  executer: Executeur;
  lancer?: (cmd: string, args: string[], o: { cwd: string }) => ProcessusIa;
  kevUrl?: string;
  ollamaUrl?: string;
  port?: number;
  inactiviteMs?: number;
  horloge?: () => number;
  surEtat?: (e: EtatIa, erreur?: string) => void;
  /** Pas d'interrogation de /v1/models au démarrage (500 ms par défaut). */
  sondageMs?: number;
  /** Pas de contrôle de l'inactivité (5 s par défaut). */
  verifInactiviteMs?: number;
}

export const DEPOT_KEV = "https://github.com/jaredpalmer/kev.git";
export const TAG_KEV = "kev-1.0";
export const COMMIT_KEV = "6b719c3c3f367295f6ef336f4f751cf5ff970abc";
export const MODELE_KEV = "jaredpalmer/kev-4b@v1.0";
export const MODELE_GEMMA = "gemma4:e4b-mlx";
const DELAI_DEMARRAGE_MS = 180_000;
const DELAI_KEV_MS = 60_000;
const DELAI_GEMMA_MS = 120_000;

/** Délai entre SIGTERM et SIGKILL quand Kev (son groupe) ne s'arrête pas. */
const DELAI_KILL_MS = 5000;

/** Groupes de processus encore vivants : tués de façon synchrone si le process Node sort sans les arrêter. */
const groupesVivants = new Set<number>();
let sortieBranchee = false;
function tuerGroupe(pid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false; // groupe déjà mort
  }
}

/**
 * Lance la commande dans son propre groupe de processus (`uv run` lance un enfant Python : tuer uv seul le laisserait
 * orphelin). `arreter` envoie SIGTERM au groupe, puis SIGKILL après `delaiKillMs` s'il vit encore. Si le process Node
 * sort sans arrêter le groupe, il est tué à la sortie.
 */
export function lancerProcessusIa(cmd: string, args: string[], o: { cwd: string; delaiKillMs?: number }): ProcessusIa {
  const enfant = spawn(cmd, args, { cwd: o.cwd, env: { ...process.env, PATH: cheminOutils() }, stdio: ["ignore", "pipe", "pipe"], detached: true });
  const pid = enfant.pid;
  if (pid !== undefined) {
    groupesVivants.add(pid);
    if (!sortieBranchee) {
      sortieBranchee = true;
      process.on("exit", () => {
        for (const g of groupesVivants) tuerGroupe(g, "SIGKILL");
      });
    }
  }
  let sorti = false;
  enfant.on("exit", () => {
    sorti = true;
    if (pid !== undefined && !tuerGroupe(pid, 0)) groupesVivants.delete(pid);
  });
  return {
    arreter: () => {
      if (pid === undefined) return;
      if (!tuerGroupe(pid, "SIGTERM")) {
        groupesVivants.delete(pid);
        return;
      }
      // Le groupe peut survivre au premier processus (un enfant qui ignore SIGTERM) : on vérifie le groupe, pas `sorti`.
      const minuterie = setTimeout(() => {
        tuerGroupe(pid, "SIGKILL");
        groupesVivants.delete(pid);
      }, o.delaiKillMs ?? DELAI_KILL_MS);
      minuterie.unref();
      const verifier = setInterval(() => {
        if (sorti && !tuerGroupe(pid, 0)) {
          clearTimeout(minuterie);
          clearInterval(verifier);
          groupesVivants.delete(pid);
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

const attendre = (ms: number) => new Promise<void>((ok) => setTimeout(ok, ms));

export const ERREUR_IA_FERMEE = "IA locale fermée";

/**
 * L'IA locale vue par un noyau. Une fois `fermer()` appelé (arrêt du noyau), ses appels sont refusés : une récolte en
 * retard ne relance pas Kev. Le noyau suivant (autre profil d'agent) reçoit un nouvel accès.
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
  /** Fermée (le navigateur quitte) : plus rien ne démarre Kev ni n'appelle Ollama. */
  private fermee = false;
  // Modifiable : l'adresse de Kev, imposée par WEBAIOS_KEV_URL ou calculée depuis le port.
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
    } catch { /* injoignable */ }
    return { kev, uv, ollama, gemma };
  }

  async installer(progres: (ligne: string) => void): Promise<void> {
    const lancer = async (cmd: string, args: string[], delaiMs?: number) => {
      progres(`$ ${[cmd, ...args].join(" ")}`);
      const r = await this.o.executer(cmd, args, delaiMs ? { delaiMs } : undefined);
      for (const l of `${r.stdout}\n${r.stderr}`.split(/\r?\n/)) if (l.trim()) progres(l);
      return r;
    };
    // 1. uv
    if ((await lancer("uv", ["--version"], 10_000)).code !== 0) throw new Error("installe uv : brew install uv");
    // 2. dépôt Kev au commit pinné
    if (!existsSync(join(this.dossierKev, ".git"))) {
      const r = await lancer("git", ["clone", "--depth", "1", "--branch", TAG_KEV, DEPOT_KEV, this.dossierKev]);
      if (r.code !== 0) throw new Error(`git clone a échoué : ${r.stderr.trim()}`);
    }
    const tete = await this.o.executer("git", ["-C", this.dossierKev, "rev-parse", "HEAD"]);
    if (tete.code !== 0 || tete.stdout.trim() !== COMMIT_KEV) {
      throw new Error(`Le commit de Kev n'est pas celui attendu (${COMMIT_KEV}) : ${tete.stdout.trim() || tete.stderr.trim()}`);
    }
    // 3. dépendances
    const sync = await lancer("uv", ["sync", "--extra", "serve", "--project", this.dossierKev]);
    if (sync.code !== 0) throw new Error(`uv sync a échoué : ${sync.stderr.trim()}`);
    // 4. modèle Gemma
    const tire = await lancer("ollama", ["pull", MODELE_GEMMA]);
    if (tire.code !== 0) throw new Error(`ollama pull a échoué : ${tire.stderr.trim()}`);
  }

  async kev(corps: { state: unknown; questions: Record<string, unknown> }): Promise<unknown> {
    if (this.fermee) throw new Error(ERREUR_IA_FERMEE);
    await this.assurerKev();
    this.dernierUsage = this.horloge();
    let r: Response;
    try {
      r = await fetch(`${this.kevUrl}/v1/systemone`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(corps),
        signal: AbortSignal.timeout(DELAI_KEV_MS),
      });
    } catch (e) {
      throw new Error(`Kev ne répond pas : ${(e as Error).message}`);
    }
    if (!r.ok) throw new Error(`Kev a répondu ${r.status}`);
    this.dernierUsage = this.horloge();
    return ((await r.json()) as { answers: unknown }).answers;
  }

  async gemma(o: { prompt: string; images?: string[]; json?: boolean }): Promise<string | unknown> {
    if (this.fermee) throw new Error(ERREUR_IA_FERMEE);
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
        signal: AbortSignal.timeout(DELAI_GEMMA_MS),
      });
    } catch {
      throw new Error("Ollama n'est pas lancé");
    }
    if (!r.ok) throw new Error(`Ollama a répondu ${r.status}`);
    const contenu = ((await r.json()) as { message?: { content?: string } }).message?.content ?? "";
    if (!o.json) return contenu;
    try {
      return JSON.parse(contenu);
    } catch {
      throw new Error("Gemma n'a pas rendu du JSON valide");
    }
  }

  /** Arrête Kev pour de bon : kev() et gemma() sont refusés ensuite (arreter(), lui, laisse relancer). */
  async fermer(): Promise<void> {
    this.fermee = true;
    await this.arreter();
  }

  /** Un accès pour un noyau, fermé avec lui (voir AccesIa). */
  acces(): AccesIa {
    let ferme = false;
    // Vérifié avant l'appel : kev() lance Kev de façon synchrone, avant sa première attente ; fermer() l'arrête ensuite.
    return {
      kev: (corps) => (ferme ? Promise.reject(new Error(ERREUR_IA_FERMEE)) : this.kev(corps)),
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
      if (gen !== this.generation) return; // arreter() est passé par là
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
      } catch { /* pas encore prêt */ }
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
