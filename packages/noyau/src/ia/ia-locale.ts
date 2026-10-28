import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Executeur } from "../conteneur/executeur.js";

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

const lancerParDefaut: NonNullable<OptionsIaLocale["lancer"]> = (cmd, args, o) => {
  const enfant = spawn(cmd, args, { cwd: o.cwd, stdio: ["ignore", "pipe", "pipe"] });
  return {
    arreter: () => { enfant.kill("SIGTERM"); },
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
};

const attendre = (ms: number) => new Promise<void>((ok) => setTimeout(ok, ms));

export class IaLocale {
  private etatCourant: EtatIa = "arretee";
  private erreurCourante?: string;
  private processus?: ProcessusIa;
  private demarrage?: Promise<void>;
  private minuteur?: NodeJS.Timeout;
  private dernierUsage = 0;
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
    const sync = await lancer("uv", ["sync", "--extra", "serve"]);
    if (sync.code !== 0) throw new Error(`uv sync a échoué : ${sync.stderr.trim()}`);
    // 4. modèle Gemma
    const tire = await lancer("ollama", ["pull", MODELE_GEMMA]);
    if (tire.code !== 0) throw new Error(`ollama pull a échoué : ${tire.stderr.trim()}`);
  }

  async kev(corps: { state: unknown; questions: Record<string, unknown> }): Promise<unknown> {
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

  async arreter(): Promise<void> {
    if (this.minuteur) clearInterval(this.minuteur);
    this.minuteur = undefined;
    const p = this.processus;
    this.processus = undefined;
    this.demarrage = undefined;
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
      if (mort) {
        const msg = `Kev n'a pas démarré : ${lignes.slice(-5).join("\n") || `code ${sortie}`}`;
        this.changer("erreur", msg);
        throw new Error(msg);
      }
      try {
        const r = await fetch(`${this.kevUrl}/v1/models`, { signal: AbortSignal.timeout(2000) });
        if (r.ok) {
          this.dernierUsage = this.horloge();
          this.changer("active");
          this.surveillerInactivite();
          return;
        }
      } catch { /* pas encore prêt */ }
      await attendre(pas);
    }
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
