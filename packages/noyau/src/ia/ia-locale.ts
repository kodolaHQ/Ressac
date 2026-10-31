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
  /** Attente maximale, à la fermeture, de la fin d'une installation annulée (3 s par défaut). */
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

/** Délai entre SIGTERM et SIGKILL quand Kev (son groupe) ne s'arrête pas. */
const DELAI_KILL_MS = 5000;

/**
 * Lance la commande dans son propre groupe de processus (`uv run` lance un enfant Python : tuer uv seul le laisserait
 * orphelin). `arreter` envoie SIGTERM au groupe, puis SIGKILL après `delaiKillMs` s'il vit encore. Si le process Node
 * sort sans arrêter le groupe, il est tué à la sortie.
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
      // Le groupe peut survivre au premier processus (un enfant qui ignore SIGTERM) : on vérifie le groupe, pas `sorti`.
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

/** Le délai de l'appel, et le signal de l'appelant s'il y en a un. */
const delaiEt = (ms: number, signal?: AbortSignal) => (signal ? AbortSignal.any([AbortSignal.timeout(ms), signal]) : AbortSignal.timeout(ms));
/** Le signal de l'appelant est levé : l'appel est abandonné (sinon l'erreur d'origine). */
const verifierAbandon = (signal?: AbortSignal) => {
  if (signal?.aborted) throw new Error(IA_ABANDONNEE);
};

const attendre = (ms: number) => new Promise<void>((ok) => setTimeout(ok, ms));

export const ERREUR_IA_FERMEE = "IA locale fermée";
export const ERREUR_INSTALLATION_ANNULEE = "Installation annulée";
/** Attente maximale de la fin d'une installation annulée quand l'app quitte. */
const DELAI_ANNULATION_MS = 3000;

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
  /** Installation en cours : son annulation et sa fin (réussie ou non). */
  private installation?: { controleur: AbortController; fin: Promise<unknown> };
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

  /** Dossier où Kev est cloné avant d'être renommé en `kev/` : un clone interrompu n'y laisse jamais un dépôt partiel. */
  private get dossierClone() { return join(this.o.dossier, "kev.clone-en-cours"); }

  /**
   * Installe Kev et Gemma. Annulée par `annulerInstallation()` ou `fermer()` : la commande en cours est tuée (tout son
   * groupe), aucune suivante ne part, un clone partiel est effacé, et la promesse est rejetée « Installation annulée ».
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

  /** Annule l'installation en cours, s'il y en a une (sans attendre sa fin). */
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
    // 2. dépôt Kev au commit pinné, cloné à côté puis renommé. Le dossier de clonage n'appartient qu'à ce code : le reste
    // d'un clone interrompu (app tuée avant d'avoir pu l'effacer) est effacé avant de recloner.
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
    // 3. dépendances (une synchronisation interrompue est reprise par la suivante, ou par `uv run` au démarrage de Kev)
    const sync = await lancer("uv", ["sync", "--extra", "serve", "--project", this.dossierKev]);
    if (sync.code !== 0) throw new Error(`uv sync a échoué : ${sync.stderr.trim()}`);
    // 4. modèle Gemma. Tuer `ollama pull` coupe sa requête au serveur Ollama, qui arrête le téléchargement et garde ses
    // morceaux pour la reprise : ils sont à Ollama (partagés avec l'utilisateur), on n'y touche pas.
    const tire = await lancer("ollama", ["pull", MODELE_GEMMA]);
    if (tire.code !== 0) throw new Error(`ollama pull a échoué : ${tire.stderr.trim()}`);
  }

  async kev(corps: { state: unknown; questions: Record<string, unknown> }, o: { signal?: AbortSignal } = {}): Promise<unknown> {
    if (this.fermee) throw new Error(ERREUR_IA_FERMEE);
    verifierAbandon(o.signal);
    await this.assurerKev();
    verifierAbandon(o.signal);
    this.dernierUsage = this.horloge();
    let r: Response;
    try {
      r = await fetch(`${this.kevUrl}/v1/systemone`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(corps),
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

  /** Arrête Kev pour de bon : kev() et gemma() sont refusés ensuite (arreter(), lui, laisse relancer). */
  async fermer(): Promise<void> {
    this.fermee = true;
    const installation = this.installation;
    if (installation) {
      // L'app quitte : l'installation est annulée ; son nettoyage est attendu, mais jamais plus que le délai.
      installation.controleur.abort();
      let minuterie: NodeJS.Timeout | undefined;
      const delai = new Promise<void>((ok) => (minuterie = setTimeout(ok, this.o.delaiAnnulationMs ?? DELAI_ANNULATION_MS)));
      await Promise.race([installation.fin, delai]);
      clearTimeout(minuterie);
    }
    await this.arreter();
  }

  /** Un accès pour un noyau, fermé avec lui (voir AccesIa). */
  acces(): AccesIa {
    let ferme = false;
    // Vérifié avant l'appel : kev() lance Kev de façon synchrone, avant sa première attente ; fermer() l'arrête ensuite.
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
