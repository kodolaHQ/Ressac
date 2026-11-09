import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { request } from "node:http";
import { join } from "node:path";
import type { SpacePaths } from "../paths.js";
import { containerPortRange, type Workshop } from "../container/workshop.js";
import { validFolder, readProjects, watchProjects, type ProjectRead } from "./manifest.js";

/** Time an app has to answer on its port before « En erreur ». */
export const READY_DELAY_MS = 60_000;
const PROBE_INTERVAL_MS = 250;
const ERROR_LINES = 20;
export const NO_PORT_LEFT_MESSAGE = "Plus de port libre : arrête une application.";

/** `preparation`: the container starts. */
export type AppState = "arretee" | "preparation" | "lancement" | "en-marche" | "erreur";

export interface Application {
  dossier: string;
  nom: string;
  type: "application" | "poc" | "sans-fiche";
  origine?: string;
  sansFiche?: string;
  creeLe: string;
  etat: AppState;
  port?: number;
  erreur?: string;
}

/** Launches an app's `docker exec` client; argv[0] is the docker CLI. */
export type Launcher = (argv: string[]) => { surFin(r: (code: number | null) => void): void; tuer(): void };

const defaultLauncher: Launcher = (argv) => {
  const p = spawn(argv[0]!, argv.slice(1), { stdio: "ignore" });
  const callbacks: ((code: number | null) => void)[] = [];
  let finished = false;
  const finish = (code: number | null) => {
    if (finished) return;
    finished = true;
    for (const r of callbacks) r(code);
  };
  p.on("exit", (code) => finish(code));
  p.on("error", () => finish(null));
  return { surFin: (r) => callbacks.push(r), tuer: () => p.kill() };
};

/**
 * Any HTTP response: a server is listening. Connection refused or cut: free port (Docker's proxy accepts
 * the connection on a published port then cuts it if nothing listens in the container). The rest: port taken by something else.
 */
export function probeByDefault(port: number): Promise<"http" | "occupe" | "libre"> {
  return new Promise((resolve) => {
    const req = request({ host: "127.0.0.1", port, path: "/", method: "GET", timeout: 1000 }, (res) => {
      res.resume();
      resolve("http");
    });
    req.on("timeout", () => req.destroy(new Error("délai")));
    req.on("error", (e: NodeJS.ErrnoException) => resolve(e.code === "ECONNREFUSED" || e.code === "ECONNRESET" ? "libre" : "occupe"));
    req.end();
  });
}

type Outcome = { type: "pret" } | { type: "fin"; code: number | null } | { type: "delai" } | { type: "arret" };

/** A launch in progress or running. `arret`: the stop was requested, the end of the process is no longer an error. */
interface Launch {
  arret: boolean;
  processus?: ReturnType<Launcher>;
  reveiller?: (i: Outcome) => void;
}

interface Tracking {
  etat: AppState;
  port?: number;
  erreur?: string;
  lancement?: Launch;
}

export class ApplicationManager {
  private readonly chemins: SpacePaths;
  private readonly atelier: Workshop;
  private readonly lanceur: Launcher;
  private readonly ports: [number, number];
  private readonly delaiPretMs: number;
  private readonly intervalleSondeMs: number;
  private readonly sonder: (port: number) => Promise<"http" | "occupe" | "libre">;
  private readonly surChange: () => void;
  private readonly suivis = new Map<string, Tracking>();
  /** Last launch requested per folder: two launches of the same app follow each other. */
  private readonly files = new Map<string, Promise<unknown>>();
  /**
   * Number of stops requested per folder. A launch notes this number when requested: if it changed when the
   * launch really starts (waiting in the queue, reading projects), the stop targeted it too.
   */
  private readonly arrets = new Map<string, number>();
  private finSurveillance?: () => Promise<void>;
  /**
   * Stop scripts in progress per folder, and cleanup of orphans at startup: they target processes by their
   * mark, at each signal. A launch awaits them before starting its process, otherwise it would be killed with the old one.
   */
  private readonly arretsEnCours = new Map<string, Promise<void>>();
  private menage: Promise<void> = Promise.resolve();

  constructor(o: {
    chemins: SpacePaths;
    atelier: Workshop;
    lanceur?: Launcher;
    ports?: [number, number];
    delaiPretMs?: number;
    /** For tests: the gap between two port probes. */
    intervalleSondeMs?: number;
    sonder?: (port: number) => Promise<"http" | "occupe" | "libre">;
    surChange?: () => void;
  }) {
    this.chemins = o.chemins;
    this.atelier = o.atelier;
    this.lanceur = o.lanceur ?? defaultLauncher;
    this.ports = o.ports ?? containerPortRange();
    this.delaiPretMs = o.delaiPretMs ?? READY_DELAY_MS;
    this.intervalleSondeMs = o.intervalleSondeMs ?? PROBE_INTERVAL_MS;
    this.sonder = o.sonder ?? probeByDefault;
    this.surChange = o.surChange ?? (() => {});
  }

  /** To be called once per browser life: apps of a previous life are stopped. */
  async demarrer(): Promise<void> {
    // Watching first: the cleanup waits for Docker, sometimes a long time, and the page must follow the projects until then.
    this.finSurveillance ??= watchProjects(this.chemins, () => this.surChange());
    // Noted right away: a launch requested during this cleanup waits for it.
    this.menage = (async () => {
      if ((await this.atelier.etat()) === "demarre") await this.atelier.arreterApplicationsOrphelines();
    })();
    await this.menage;
  }

  async arreterSurveillance(): Promise<void> {
    await this.finSurveillance?.();
    this.finSurveillance = undefined;
  }

  /** In-memory state of an app, without reading the disk. */
  etatDe(folder: string): AppState {
    return this.suivis.get(folder)?.etat ?? "arretee";
  }

  async liste(): Promise<Application[]> {
    return (await readProjects(this.chemins)).map((p) => this.vue(p));
  }

  private vue(p: ProjectRead): Application {
    const s = this.suivis.get(p.dossier);
    return {
      dossier: p.dossier,
      nom: p.nom,
      creeLe: p.creeLe,
      ...("manifeste" in p
        ? { type: p.manifeste.type, ...(p.manifeste.origine ? { origine: p.manifeste.origine } : {}) }
        : { type: "sans-fiche" as const, sansFiche: p.sansFiche }),
      etat: s?.etat ?? "arretee",
      ...(s?.port !== undefined ? { port: s.port } : {}),
      ...(s?.erreur !== undefined ? { erreur: s.erreur } : {}),
    };
  }

  private changer(folder: string, s: Tracking): void {
    this.suivis.set(folder, s);
    this.surChange();
  }

  /** Resolves to « en-marche », « erreur », or « arretee » if the app is stopped in the meantime. Restarts a running app. */
  lancer(folder: string): Promise<Application> {
    const token = this.arrets.get(folder) ?? 0;
    const next = (this.files.get(folder) ?? Promise.resolve()).catch(() => {}).then(() => this.lancerMaintenant(folder, token));
    this.files.set(folder, next);
    return next;
  }

  private async lancerMaintenant(folder: string, token: number): Promise<Application> {
    const project = (await readProjects(this.chemins)).find((p) => p.dossier === folder);
    if (!project) throw new Error(`Projet inconnu : ${folder}`);
    if (!("manifeste" in project)) throw new Error(`Projet sans fiche, impossible à lancer (${project.sansFiche}) : ${folder}`);
    // Restart: internal stop of the current instance, which does not count as a requested stop.
    if (this.suivis.get(folder)?.lancement) await this.arreterLancement(folder);
    if ((this.arrets.get(folder) ?? 0) !== token) {
      if (this.etatDe(folder) !== "arretee") this.changer(folder, { etat: "arretee" });
      return this.vue(project);
    }

    const l: Launch = { arret: false };
    /** Final state of the launch, unless the stop was requested in the meantime (the app is then « arretee »). */
    const end = (s: Tracking) => {
      if (!l.arret) this.changer(folder, s);
      return this.vue(project);
    };
    this.suivis.set(folder, { ...this.suivis.get(folder), etat: this.etatDe(folder), lancement: l });

    try {
      let state = await this.atelier.etat();
      if (l.arret) return this.vue(project);
      if (state !== "docker-absent" && state !== "demarre") {
        this.changer(folder, { etat: "preparation", lancement: l });
        state = await this.atelier.assurerDemarre();
        if (l.arret) return this.vue(project);
      }
      if (state === "docker-absent") return end({ etat: "erreur", erreur: "Docker n'est pas lancé." });
    } catch (e) {
      return end({ etat: "erreur", erreur: (e as Error).message });
    }

    await Promise.all([this.menage, this.arretsEnCours.get(folder)].map((p) => p?.catch(() => {})));
    if (l.arret) return this.vue(project);
    const port = await this.choisirPort();
    if (l.arret) return this.vue(project);
    if (port === null) return end({ etat: "erreur", erreur: NO_PORT_LEFT_MESSAGE });
    this.changer(folder, { etat: "lancement", port, lancement: l });

    const outcome = new Promise<Outcome>((r) => (l.reveiller = r));
    l.processus = this.lanceur(this.atelier.commandeApplication(folder, project.manifeste.lancement, port));
    l.processus.surFin((code) => {
      if (l.arret) return;
      if (l.reveiller) l.reveiller({ type: "fin", code });
      else void this.finInattendue(folder, l, code);
    });

    const delay = setTimeout(() => l.reveiller?.({ type: "delai" }), this.delaiPretMs);
    let probe: NodeJS.Timeout | undefined;
    const probeLater = () => {
      probe = setTimeout(async () => {
        if ((await this.sonder(port)) === "http") l.reveiller?.({ type: "pret" });
        else if (l.reveiller) probeLater();
      }, this.intervalleSondeMs);
    };
    probeLater();
    const i = await outcome;
    l.reveiller = undefined;
    clearTimeout(delay);
    clearTimeout(probe);

    switch (i.type) {
      case "arret":
        return this.vue(project);
      case "pret":
        return end({ etat: "en-marche", port, lancement: l });
      case "fin":
        await this.finInattendue(folder, l, i.code);
        return this.vue(project);
      case "delai": {
        const error = await this.avecJournal(folder, `L'application ne répond pas sur le port ${port} après ${Math.round(this.delaiPretMs / 1000)} s.`);
        if (l.arret) return this.vue(project);
        // Stop requested before killing: the end of the process does not replace this message.
        l.arret = true;
        this.changer(folder, { etat: "erreur", erreur: error });
        await this.atelier.arreterApplication(folder);
        l.processus.tuer();
        return this.vue(project);
      }
    }
  }

  /** The process ended without a stop request: during launch or running, it is an error. */
  private async finInattendue(folder: string, l: Launch, code: number | null): Promise<void> {
    const error = await this.avecJournal(folder, `Arrêtée avec le code ${code ?? "inconnu"}`);
    if (l.arret || this.suivis.get(folder)?.lancement !== l) return;
    l.arret = true;
    this.changer(folder, { etat: "erreur", erreur: error });
  }

  private async avecJournal(folder: string, message: string): Promise<string> {
    const end = await this.journal(folder, ERROR_LINES);
    return end ? `${message}\n${end}` : message;
  }

  /** First port of the range neither taken by a tracked app nor busy on the machine. */
  private async choisirPort(): Promise<number | null> {
    const taken = (p: number) =>
      [...this.suivis.values()].some((s) => s.port === p && (s.etat === "lancement" || s.etat === "en-marche"));
    for (let p = this.ports[0]; p <= this.ports[1]; p++) {
      if (taken(p)) continue;
      const r = await this.sonder(p);
      // Re-checked after the probe: another launch may have taken it in the meantime.
      if (r === "libre" && !taken(p)) return p;
    }
    return null;
  }

  /** Stops the app, and cancels its launches requested but not yet started. */
  async arreter(folder: string): Promise<void> {
    this.arrets.set(folder, (this.arrets.get(folder) ?? 0) + 1);
    await this.arreterLancement(folder);
  }

  private async arreterLancement(folder: string): Promise<void> {
    const l = this.suivis.get(folder)?.lancement;
    if (!l) return;
    l.arret = true;
    this.changer(folder, { etat: "arretee" });
    l.reveiller?.({ type: "arret" });
    const stop = this.atelier.arreterApplication(folder);
    this.arretsEnCours.set(folder, stop);
    try {
      await stop;
    } finally {
      if (this.arretsEnCours.get(folder) === stop) this.arretsEnCours.delete(folder);
    }
    l.processus?.tuer();
  }

  /** Project deleted: its state (an error, a port) must not reappear on a project recreated under that name. */
  oublier(folder: string): void {
    const s = this.suivis.get(folder);
    // A launch in progress keeps its state: it is up to the stop to finish it.
    if (!s || s.lancement) return;
    this.suivis.delete(folder);
    this.surChange();
  }

  async toutArreter(): Promise<void> {
    const folders = new Set([...this.suivis.keys(), ...this.files.keys()]);
    await Promise.all([...folders].map((d) => this.arreter(d)));
  }

  /** The last `lignes` lines of the app's log (read on the Mac), empty if it does not exist. */
  async journal(folder: string, lignes = 50): Promise<string> {
    if (!validFolder(folder)) throw new Error(`dossier d'application invalide : ${folder}`);
    let content: string;
    try {
      content = await readFile(join(this.chemins.journaux, `${folder}.log`), "utf8");
    } catch {
      return "";
    }
    return content.replace(/\n+$/, "").split("\n").slice(-lignes).join("\n");
  }
}
