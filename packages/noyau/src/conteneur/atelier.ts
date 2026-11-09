import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { dossierValide } from "../applications/manifeste.js";
import { CHEMIN_CONTENEUR, type CheminsEspace } from "../chemins.js";
import type { Proprietaire } from "../workflows/schema.js";
import { executeurParDefaut, type Executeur } from "./executeur.js";

export const NOM_CONTENEUR = "webaios-atelier";
// Read on every call so a second app (Firefox build) can run its own container.
export const nomConteneur = (): string => process.env.WEBAIOS_CONTENEUR || NOM_CONTENEUR;
export const IMAGE = "webaios-atelier:1";
export const VOLUME_HOME = "webaios-home";
/**
 * Ports published by the container, the same on the Mac and inside: 5280-5299 by default, out of Vite's range (5173…).
 * Two containers cannot publish the same ports, so a second app (Firefox build) sets WEBAIOS_PORTS_CONTENEUR (`min-max`).
 * Read on every call, like nomConteneur().
 */
export function plagePortsConteneur(): [number, number] {
  const m = /^(\d{4,5})-(\d{4,5})$/.exec(process.env.WEBAIOS_PORTS_CONTENEUR ?? "");
  const [min, max] = m ? [Number(m[1]), Number(m[2])] : [0, 0];
  return min >= 1024 && max <= 65535 && min <= max ? [min, max] : [5280, 5299];
}
/** The docker probes must not block if Docker Desktop is stuck at startup. */
const DELAI_SONDE_MS = 30_000;
/** First build: download of the base image and install of the agent. Beyond that, it is blocked. */
export const DELAI_CONSTRUCTION_MS = 20 * 60_000;

/** Dockerfile folder in the package; a browser that embeds the kernel can provide another. */
export const DOSSIER_DOCKER_PAR_DEFAUT = join(import.meta.dirname, "..", "..", "docker");
const dockerfile = (dossier: string) => join(dossier, "atelier.Dockerfile");
const LABEL_EMPREINTE = "webaios.dockerfile";

/** Fingerprint of the Dockerfile: the image and the container carry it as a label, to know whether they are up to date. */
export function empreinteDockerfile(dossierDocker = DOSSIER_DOCKER_PAR_DEFAUT): string {
  return createHash("sha256").update(readFileSync(dockerfile(dossierDocker))).digest("hex").slice(0, 12);
}

function normaliser(chemin: string): string {
  try {
    return realpathSync(chemin);
  } catch {
    return chemin;
  }
}

/**
 * Name of a run's container: `webaios-recolte-<id>` for a widget (a bare id is a widget's),
 * `webaios-action-<id>` for an action. The id goes into a docker name, any dubious id is refused.
 */
export function nomRecolte(p: string | Proprietaire): string {
  const { type, id } = typeof p === "string" ? { type: "widget" as const, id: p } : p;
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`id ${type === "widget" ? "de widget" : "d'action"} invalide : ${id}`);
  return type === "widget" ? `webaios-recolte-${id}` : `webaios-action-${id}`;
}

/** Maximum duration of a harvest in its container (seconds), before SIGTERM then SIGKILL 5 s later. */
export const DELAI_RECOLTE_S = 180;

/** An app's folder goes into a grep expression between apostrophes: any dubious name is refused. */
function dossierApplication(dossier: string): string {
  if (!dossierValide(dossier)) throw new Error(`dossier d'application invalide : ${dossier}`);
  return dossier;
}

export type EtatAtelier = "docker-absent" | "absent" | "arrete" | "demarre";

/** Looks for the docker CLI in the PATH then at known locations (Finder does not have the shell's PATH). */
export function trouverDocker(
  env: NodeJS.ProcessEnv = process.env,
  existe: (chemin: string) => boolean = existsSync,
): string | null {
  const candidats = [
    ...(env.PATH ?? "").split(":").filter(Boolean).map((d) => join(d, "docker")),
    "/usr/local/bin/docker",
    "/opt/homebrew/bin/docker",
    ...(env.HOME ? [join(env.HOME, ".orbstack", "bin", "docker"), join(env.HOME, ".docker", "bin", "docker")] : []),
    "/Applications/Docker.app/Contents/Resources/bin/docker",
  ];
  return candidats.find((c) => existe(c)) ?? null;
}

function fichierSession(id: string): string {
  if (!/^[a-z0-9]+$/.test(id)) throw new Error(`id de session invalide : ${id}`);
  return `/tmp/webaios-session-${id}.pid`;
}

/** Variable set on each session: everything the agent launches inherits it, even detached from its group (nohup, setsid). */
export const VARIABLE_SESSION = "WEBAIOS_SESSION";

/**
 * Sends HUP, then TERM, then KILL to the processes listed by the shell function `cibles` (pid, or -pgid for a group).
 * claude intercepts HUP and TERM without necessarily quitting: each signal has 2 s to act.
 */
function escalade(cibles: string): string[] {
  return [
    `cibles() { ${cibles}; }`,
    // No « -- »: the kill of dash (the container's sh) refuses it, and the group would never be targeted.
    `signaler() { for c in $(cibles); do kill -$1 "$c" 2>/dev/null; done; }`,
    `vivant() { for c in $(cibles); do kill -0 "$c" 2>/dev/null && return 0; done; return 1; }`,
    `for s in HUP TERM; do signaler $s; i=0; while [ $i -lt 20 ] && vivant; do sleep 0.1; i=$((i + 1)); done; vivant || exit 0; done`,
    `signaler KILL`,
  ];
}

/** Processes that carry the mark `motif` (grep expression on a whole environment variable). */
const marques = (motif: string) =>
  `for d in /proc/[0-9]*; do grep -qzx '${motif}' "$d/environ" 2>/dev/null && echo "\${d#/proc/}"; done`;

/** A text read as is by grep (basic expression): « my.app » does not target « myxapp ». */
const litteral = (texte: string) => texte.replace(/[\\.*[\]^$]/g, "\\$&");

/**
 * Stops session `id` whose PID is noted in `f`: its group (the agent and what it launched), and any process
 * that carries its mark (a demo server detached by the agent).
 */
export function scriptArretSession(f: string, id: string): string {
  return [
    `p=$(cat ${f} 2>/dev/null) || p=`,
    `rm -f ${f}`,
    ...escalade(`[ -n "$p" ] && echo "-$p $p"; ${marques(`${VARIABLE_SESSION}=${id}`)}`),
  ].join("\n");
}

/** Stops all marked sessions, whatever their window (see arreterSessionsOrphelines). */
export function scriptArretOrphelins(): string {
  return ["rm -f /tmp/webaios-session-*.pid", ...escalade(marques(`${VARIABLE_SESSION}=.*`))].join("\n");
}

/** Mark of the processes of a launched app: never confused with that of sessions (`WEBAIOS_SESSION`). */
export const VARIABLE_APPLICATION = "WEBAIOS_APP";

export class Atelier {
  private readonly chemins: CheminsEspace;
  private readonly executer: Executeur;
  private readonly docker: string | null;
  private readonly dossierDocker: string;
  /** Startup in progress, shared: two windows opening an agent do not build the image twice. */
  private demarrage: Promise<EtatAtelier> | null = null;

  constructor(o: { chemins: CheminsEspace; executer?: Executeur; docker?: string | null; dossierDocker?: string }) {
    this.dossierDocker = o.dossierDocker ?? DOSSIER_DOCKER_PAR_DEFAUT;
    this.chemins = o.chemins;
    this.executer = o.executer ?? executeurParDefaut;
    this.docker = o.docker === undefined ? trouverDocker() : o.docker;
  }

  private lancer(args: string[], delaiMs?: number) {
    return this.executer(this.docker!, args, delaiMs ? { delaiMs } : undefined);
  }

  async etat(): Promise<EtatAtelier> {
    if (!this.docker || (await this.lancer(["info"], DELAI_SONDE_MS)).code !== 0) return "docker-absent";
    const r = await this.lancer(["inspect", "-f", "{{.State.Running}}", nomConteneur()], DELAI_SONDE_MS);
    if (r.code !== 0) return "absent";
    return r.stdout.trim() === "true" ? "demarre" : "arrete";
  }

  /** Is the existing container mounted on the right root and built from the current Dockerfile? */
  private async conteneurAJour(empreinte: string): Promise<boolean> {
    const format = `{{range .Mounts}}{{if eq .Destination "${CHEMIN_CONTENEUR}"}}{{.Source}}{{end}}{{end}}|{{index .Config.Labels "${LABEL_EMPREINTE}"}}`;
    const r = await this.lancer(["inspect", "-f", format, nomConteneur()], DELAI_SONDE_MS);
    const [source = "", label = ""] = r.stdout.trim().split("|");
    return r.code === 0 && normaliser(source) === normaliser(this.chemins.racine) && label === empreinte;
  }

  assurerDemarre(): Promise<EtatAtelier> {
    this.demarrage ??= this.demarrer().finally(() => (this.demarrage = null));
    return this.demarrage;
  }

  private async demarrer(): Promise<EtatAtelier> {
    let etat = await this.etat();
    if (etat === "docker-absent") return etat;
    const empreinte = empreinteDockerfile(this.dossierDocker);
    // A container created on another folder or with an old Dockerfile is recreated; /workspace and
    // the credentials volume are kept, only the container layer is lost.
    if (etat !== "absent" && !(await this.conteneurAJour(empreinte))) {
      await this.lancer(["rm", "-f", nomConteneur()], DELAI_SONDE_MS);
      etat = "absent";
    }
    if (etat === "demarre") return etat;
    if (etat === "arrete") {
      await this.lancer(["start", nomConteneur()], DELAI_SONDE_MS);
      return this.etat();
    }
    const image = await this.lancer(["image", "inspect", "-f", `{{index .Config.Labels "${LABEL_EMPREINTE}"}}`, IMAGE], DELAI_SONDE_MS);
    if (image.code !== 0 || image.stdout.trim() !== empreinte) {
      const build = await this.lancer(["build", "-t", IMAGE, "--label", `${LABEL_EMPREINTE}=${empreinte}`, "-f", dockerfile(this.dossierDocker), this.dossierDocker], DELAI_CONSTRUCTION_MS);
      if (build.code !== 0) throw new Error(`Construction de l'image ${IMAGE} impossible : ${build.stderr}`);
    }
    const ports = plagePortsConteneur().join("-");
    const run = await this.lancer([
      "run", "-d",
      "--name", nomConteneur(),
      "--add-host", "host.docker.internal:host-gateway",
      "-v", `${this.chemins.racine}:${CHEMIN_CONTENEUR}`,
      "-v", `${VOLUME_HOME}:/home/node`,
      "-p", `127.0.0.1:${ports}:${ports}`,
      // AGENTS.md tells the agent to keep its hand-run servers in this range.
      "-e", `WEBAIOS_PORTS=${ports}`,
      "-w", CHEMIN_CONTENEUR,
      IMAGE,
      "sleep", "infinity",
    ], DELAI_SONDE_MS);
    if (run.code !== 0) {
      // A failed run (port already taken…) can leave the container created without network: the next start must not reuse it.
      await this.lancer(["rm", "-f", nomConteneur()], DELAI_SONDE_MS);
      throw new Error(`Démarrage du conteneur ${nomConteneur()} impossible : ${run.stderr}`);
    }
    return this.etat();
  }

  /**
   * Run of a workflow, in a disposable container with no network: it sees only the files folder and the
   * engine folder (that of the harvester and its modules), read-only, and talks to the kernel only through its standard input and
   * output (`-i`). `delaiS`: the container is stopped after this delay (+5 s to finish).
   */
  commandeRecolte(proprietaire: string | Proprietaire, dossierFichiers: string, moteur: string, delaiS: number = DELAI_RECOLTE_S): string[] {
    if (!this.docker) throw new Error("Docker introuvable");
    // « : » would change the meaning of -v (target, options): such a path cannot be mounted safely.
    for (const c of [dossierFichiers, moteur]) if (c.includes(":")) throw new Error(`chemin non montable : ${c}`);
    return [
      this.docker, "run", "-i", "--rm",
      "--name", nomRecolte(proprietaire),
      "--network", "none",
      "--read-only",
      "--tmpfs", "/tmp",
      "-v", `${dossierFichiers}:/widget:ro`,
      "-v", `${moteur}:/opt/webaios/moteur:ro`,
      "--memory", "512m",
      "--pids-limit", "128",
      IMAGE,
      "timeout", "-k", "5", String(delaiS),
      "node", "/opt/webaios/moteur/recolteur.mjs", "/widget",
    ];
  }

  /** Killing the `docker run` client is not enough: the container is force-deleted. */
  async supprimerRecolte(proprietaire: string | Proprietaire): Promise<void> {
    if (this.docker) await this.lancer(["rm", "-f", nomRecolte(proprietaire)], DELAI_SONDE_MS);
  }

  /**
   * Interactive agent session: the shell notes its PID in the container before becoming the agent (exec), so
   * that `arreterSession` can kill it there. Killing the local `docker exec` client would leave the agent running.
   */
  commandeSession(id: string, argv: string[]): string[] {
    const f = fichierSession(id);
    return this.commandeExec(["sh", "-c", `echo $$ > ${f}; exec "$@"`, "webaios-session", ...argv], { interactif: true, env: { [VARIABLE_SESSION]: id } });
  }

  async arreterSession(id: string): Promise<void> {
    if (!this.docker) return;
    await this.lancer(["exec", nomConteneur(), "sh", "-c", scriptArretSession(fichierSession(id), id)], DELAI_SONDE_MS);
  }

  /**
   * At app launch: the agents (and their servers) of a previous app that could not stop them (killed outright,
   * crashed) have no window anymore. Only one app runs at a time on the workshop.
   */
  async arreterSessionsOrphelines(): Promise<void> {
    if (this.docker) await this.lancer(["exec", nomConteneur(), "sh", "-c", scriptArretOrphelins()], DELAI_SONDE_MS);
  }

  /**
   * Application of a project, launched in its folder with its mark and its port. The shell redirects everything to the
   * log (rewritten at each launch) then evaluates the manifest's command: the folder and the command go as
   * arguments ($1, $2), never pasted into the script.
   */
  commandeApplication(dossier: string, commande: string, port: number): string[] {
    dossierApplication(dossier);
    const journaux = `${CHEMIN_CONTENEUR}/.webaios/journaux`;
    return this.commandeExec(
      ["sh", "-c", `mkdir -p ${journaux}; exec >"${journaux}/$1.log" 2>&1; eval "$2"`, "webaios-app", dossier, commande.replaceAll("{port}", String(port))],
      { interactif: false, env: { [VARIABLE_APPLICATION]: dossier, PORT: String(port) }, dossier: `${CHEMIN_CONTENEUR}/projets/${dossier}` },
    );
  }

  /** Stops app `dossier`: any process that carries its mark, even detached from the shell that launched it. */
  async arreterApplication(dossier: string): Promise<void> {
    if (this.docker) await this.lancer(["exec", nomConteneur(), "sh", "-c", escalade(marques(`${VARIABLE_APPLICATION}=${litteral(dossierApplication(dossier))}`)).join("\n")], DELAI_SONDE_MS);
  }

  /** At browser launch: apps of a previous life have nobody left to follow them. */
  async arreterApplicationsOrphelines(): Promise<void> {
    if (this.docker) await this.lancer(["exec", nomConteneur(), "sh", "-c", escalade(marques(`${VARIABLE_APPLICATION}=.*`)).join("\n")], DELAI_SONDE_MS);
  }

  commandeExec(argv: string[], o: { interactif: boolean; env?: Record<string, string>; dossier?: string }): string[] {
    if (!this.docker) throw new Error("Docker introuvable");
    const env = Object.entries(o.env ?? {}).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
    return [this.docker, "exec", ...(o.interactif ? ["-it"] : []), ...env, "-w", o.dossier ?? CHEMIN_CONTENEUR, nomConteneur(), ...argv];
  }
}
