import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { request } from "node:http";
import { join } from "node:path";
import type { CheminsEspace } from "../chemins.js";
import { plagePortsConteneur, type Atelier } from "../conteneur/atelier.js";
import { dossierValide, lireProjets, surveillerProjets, type ProjetLu } from "./manifeste.js";

/** Time an app has to answer on its port before « En erreur ». */
export const DELAI_PRET_MS = 60_000;
const INTERVALLE_SONDE_MS = 250;
const LIGNES_ERREUR = 20;
export const MESSAGE_PLUS_DE_PORT = "Plus de port libre : arrête une application.";

/** `preparation`: the container starts. */
export type EtatApplication = "arretee" | "preparation" | "lancement" | "en-marche" | "erreur";

export interface Application {
  dossier: string;
  nom: string;
  type: "application" | "poc" | "sans-fiche";
  origine?: string;
  sansFiche?: string;
  creeLe: string;
  etat: EtatApplication;
  port?: number;
  erreur?: string;
}

/** Launches an app's `docker exec` client; argv[0] is the docker CLI. */
export type Lanceur = (argv: string[]) => { surFin(r: (code: number | null) => void): void; tuer(): void };

const lanceurParDefaut: Lanceur = (argv) => {
  const p = spawn(argv[0]!, argv.slice(1), { stdio: "ignore" });
  const rappels: ((code: number | null) => void)[] = [];
  let fini = false;
  const finir = (code: number | null) => {
    if (fini) return;
    fini = true;
    for (const r of rappels) r(code);
  };
  p.on("exit", (code) => finir(code));
  p.on("error", () => finir(null));
  return { surFin: (r) => rappels.push(r), tuer: () => p.kill() };
};

/**
 * Any HTTP response: a server is listening. Connection refused or cut: free port (Docker's proxy accepts
 * the connection on a published port then cuts it if nothing listens in the container). The rest: port taken by something else.
 */
export function sonderParDefaut(port: number): Promise<"http" | "occupe" | "libre"> {
  return new Promise((resoudre) => {
    const req = request({ host: "127.0.0.1", port, path: "/", method: "GET", timeout: 1000 }, (res) => {
      res.resume();
      resoudre("http");
    });
    req.on("timeout", () => req.destroy(new Error("délai")));
    req.on("error", (e: NodeJS.ErrnoException) => resoudre(e.code === "ECONNREFUSED" || e.code === "ECONNRESET" ? "libre" : "occupe"));
    req.end();
  });
}

type Issue = { type: "pret" } | { type: "fin"; code: number | null } | { type: "delai" } | { type: "arret" };

/** A launch in progress or running. `arret`: the stop was requested, the end of the process is no longer an error. */
interface Lancement {
  arret: boolean;
  processus?: ReturnType<Lanceur>;
  reveiller?: (i: Issue) => void;
}

interface Suivi {
  etat: EtatApplication;
  port?: number;
  erreur?: string;
  lancement?: Lancement;
}

export class GestionnaireApplications {
  private readonly chemins: CheminsEspace;
  private readonly atelier: Atelier;
  private readonly lanceur: Lanceur;
  private readonly ports: [number, number];
  private readonly delaiPretMs: number;
  private readonly intervalleSondeMs: number;
  private readonly sonder: (port: number) => Promise<"http" | "occupe" | "libre">;
  private readonly surChange: () => void;
  private readonly suivis = new Map<string, Suivi>();
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
    chemins: CheminsEspace;
    atelier: Atelier;
    lanceur?: Lanceur;
    ports?: [number, number];
    delaiPretMs?: number;
    /** For tests: the gap between two port probes. */
    intervalleSondeMs?: number;
    sonder?: (port: number) => Promise<"http" | "occupe" | "libre">;
    surChange?: () => void;
  }) {
    this.chemins = o.chemins;
    this.atelier = o.atelier;
    this.lanceur = o.lanceur ?? lanceurParDefaut;
    this.ports = o.ports ?? plagePortsConteneur();
    this.delaiPretMs = o.delaiPretMs ?? DELAI_PRET_MS;
    this.intervalleSondeMs = o.intervalleSondeMs ?? INTERVALLE_SONDE_MS;
    this.sonder = o.sonder ?? sonderParDefaut;
    this.surChange = o.surChange ?? (() => {});
  }

  /** To be called once per browser life: apps of a previous life are stopped. */
  async demarrer(): Promise<void> {
    // Watching first: the cleanup waits for Docker, sometimes a long time, and the page must follow the projects until then.
    this.finSurveillance ??= surveillerProjets(this.chemins, () => this.surChange());
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
  etatDe(dossier: string): EtatApplication {
    return this.suivis.get(dossier)?.etat ?? "arretee";
  }

  async liste(): Promise<Application[]> {
    return (await lireProjets(this.chemins)).map((p) => this.vue(p));
  }

  private vue(p: ProjetLu): Application {
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

  private changer(dossier: string, s: Suivi): void {
    this.suivis.set(dossier, s);
    this.surChange();
  }

  /** Resolves to « en-marche », « erreur », or « arretee » if the app is stopped in the meantime. Restarts a running app. */
  lancer(dossier: string): Promise<Application> {
    const jeton = this.arrets.get(dossier) ?? 0;
    const suite = (this.files.get(dossier) ?? Promise.resolve()).catch(() => {}).then(() => this.lancerMaintenant(dossier, jeton));
    this.files.set(dossier, suite);
    return suite;
  }

  private async lancerMaintenant(dossier: string, jeton: number): Promise<Application> {
    const projet = (await lireProjets(this.chemins)).find((p) => p.dossier === dossier);
    if (!projet) throw new Error(`Projet inconnu : ${dossier}`);
    if (!("manifeste" in projet)) throw new Error(`Projet sans fiche, impossible à lancer (${projet.sansFiche}) : ${dossier}`);
    // Restart: internal stop of the current instance, which does not count as a requested stop.
    if (this.suivis.get(dossier)?.lancement) await this.arreterLancement(dossier);
    if ((this.arrets.get(dossier) ?? 0) !== jeton) {
      if (this.etatDe(dossier) !== "arretee") this.changer(dossier, { etat: "arretee" });
      return this.vue(projet);
    }

    const l: Lancement = { arret: false };
    /** Final state of the launch, unless the stop was requested in the meantime (the app is then « arretee »). */
    const fin = (s: Suivi) => {
      if (!l.arret) this.changer(dossier, s);
      return this.vue(projet);
    };
    this.suivis.set(dossier, { ...this.suivis.get(dossier), etat: this.etatDe(dossier), lancement: l });

    try {
      let etat = await this.atelier.etat();
      if (l.arret) return this.vue(projet);
      if (etat !== "docker-absent" && etat !== "demarre") {
        this.changer(dossier, { etat: "preparation", lancement: l });
        etat = await this.atelier.assurerDemarre();
        if (l.arret) return this.vue(projet);
      }
      if (etat === "docker-absent") return fin({ etat: "erreur", erreur: "Docker n'est pas lancé." });
    } catch (e) {
      return fin({ etat: "erreur", erreur: (e as Error).message });
    }

    await Promise.all([this.menage, this.arretsEnCours.get(dossier)].map((p) => p?.catch(() => {})));
    if (l.arret) return this.vue(projet);
    const port = await this.choisirPort();
    if (l.arret) return this.vue(projet);
    if (port === null) return fin({ etat: "erreur", erreur: MESSAGE_PLUS_DE_PORT });
    this.changer(dossier, { etat: "lancement", port, lancement: l });

    const issue = new Promise<Issue>((r) => (l.reveiller = r));
    l.processus = this.lanceur(this.atelier.commandeApplication(dossier, projet.manifeste.lancement, port));
    l.processus.surFin((code) => {
      if (l.arret) return;
      if (l.reveiller) l.reveiller({ type: "fin", code });
      else void this.finInattendue(dossier, l, code);
    });

    const delai = setTimeout(() => l.reveiller?.({ type: "delai" }), this.delaiPretMs);
    let sonde: NodeJS.Timeout | undefined;
    const sonderPlusTard = () => {
      sonde = setTimeout(async () => {
        if ((await this.sonder(port)) === "http") l.reveiller?.({ type: "pret" });
        else if (l.reveiller) sonderPlusTard();
      }, this.intervalleSondeMs);
    };
    sonderPlusTard();
    const i = await issue;
    l.reveiller = undefined;
    clearTimeout(delai);
    clearTimeout(sonde);

    switch (i.type) {
      case "arret":
        return this.vue(projet);
      case "pret":
        return fin({ etat: "en-marche", port, lancement: l });
      case "fin":
        await this.finInattendue(dossier, l, i.code);
        return this.vue(projet);
      case "delai": {
        const erreur = await this.avecJournal(dossier, `L'application ne répond pas sur le port ${port} après ${Math.round(this.delaiPretMs / 1000)} s.`);
        if (l.arret) return this.vue(projet);
        // Stop requested before killing: the end of the process does not replace this message.
        l.arret = true;
        this.changer(dossier, { etat: "erreur", erreur });
        await this.atelier.arreterApplication(dossier);
        l.processus.tuer();
        return this.vue(projet);
      }
    }
  }

  /** The process ended without a stop request: during launch or running, it is an error. */
  private async finInattendue(dossier: string, l: Lancement, code: number | null): Promise<void> {
    const erreur = await this.avecJournal(dossier, `Arrêtée avec le code ${code ?? "inconnu"}`);
    if (l.arret || this.suivis.get(dossier)?.lancement !== l) return;
    l.arret = true;
    this.changer(dossier, { etat: "erreur", erreur });
  }

  private async avecJournal(dossier: string, message: string): Promise<string> {
    const fin = await this.journal(dossier, LIGNES_ERREUR);
    return fin ? `${message}\n${fin}` : message;
  }

  /** First port of the range neither taken by a tracked app nor busy on the machine. */
  private async choisirPort(): Promise<number | null> {
    const pris = (p: number) =>
      [...this.suivis.values()].some((s) => s.port === p && (s.etat === "lancement" || s.etat === "en-marche"));
    for (let p = this.ports[0]; p <= this.ports[1]; p++) {
      if (pris(p)) continue;
      const r = await this.sonder(p);
      // Re-checked after the probe: another launch may have taken it in the meantime.
      if (r === "libre" && !pris(p)) return p;
    }
    return null;
  }

  /** Stops the app, and cancels its launches requested but not yet started. */
  async arreter(dossier: string): Promise<void> {
    this.arrets.set(dossier, (this.arrets.get(dossier) ?? 0) + 1);
    await this.arreterLancement(dossier);
  }

  private async arreterLancement(dossier: string): Promise<void> {
    const l = this.suivis.get(dossier)?.lancement;
    if (!l) return;
    l.arret = true;
    this.changer(dossier, { etat: "arretee" });
    l.reveiller?.({ type: "arret" });
    const arret = this.atelier.arreterApplication(dossier);
    this.arretsEnCours.set(dossier, arret);
    try {
      await arret;
    } finally {
      if (this.arretsEnCours.get(dossier) === arret) this.arretsEnCours.delete(dossier);
    }
    l.processus?.tuer();
  }

  /** Project deleted: its state (an error, a port) must not reappear on a project recreated under that name. */
  oublier(dossier: string): void {
    const s = this.suivis.get(dossier);
    // A launch in progress keeps its state: it is up to the stop to finish it.
    if (!s || s.lancement) return;
    this.suivis.delete(dossier);
    this.surChange();
  }

  async toutArreter(): Promise<void> {
    const dossiers = new Set([...this.suivis.keys(), ...this.files.keys()]);
    await Promise.all([...dossiers].map((d) => this.arreter(d)));
  }

  /** The last `lignes` lines of the app's log (read on the Mac), empty if it does not exist. */
  async journal(dossier: string, lignes = 50): Promise<string> {
    if (!dossierValide(dossier)) throw new Error(`dossier d'application invalide : ${dossier}`);
    let contenu: string;
    try {
      contenu = await readFile(join(this.chemins.journaux, `${dossier}.log`), "utf8");
    } catch {
      return "";
    }
    return contenu.replace(/\n+$/, "").split("\n").slice(-lignes).join("\n");
  }
}
