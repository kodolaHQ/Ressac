import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { validFolder } from "../applications/manifest.js";
import { CONTAINER_PATH, type SpacePaths } from "../paths.js";
import type { Owner } from "../workflows/schema.js";
import { defaultRunner, type Runner } from "./runner.js";

export const CONTAINER_NAME = "webaios-atelier";
// Read on every call so a second app (Firefox build) can run its own container.
export const containerName = (): string => process.env.WEBAIOS_CONTENEUR || CONTAINER_NAME;
export const IMAGE = "webaios-atelier:1";
export const VOLUME_HOME = "webaios-home";
/**
 * Ports published by the container, the same on the Mac and inside: 5280-5299 by default, out of Vite's range (5173…).
 * Two containers cannot publish the same ports, so a second app (Firefox build) sets WEBAIOS_PORTS_CONTENEUR (`min-max`).
 * Read on every call, like containerName().
 */
export function containerPortRange(): [number, number] {
  const m = /^(\d{4,5})-(\d{4,5})$/.exec(process.env.WEBAIOS_PORTS_CONTENEUR ?? "");
  const [min, max] = m ? [Number(m[1]), Number(m[2])] : [0, 0];
  return min >= 1024 && max <= 65535 && min <= max ? [min, max] : [5280, 5299];
}
/** The docker probes must not block if Docker Desktop is stuck at startup. */
const PROBE_DELAY_MS = 30_000;
/** First build: download of the base image and install of the agent. Beyond that, it is blocked. */
export const BUILD_DELAY_MS = 20 * 60_000;

/** Dockerfile folder in the package; a browser that embeds the kernel can provide another. */
export const DEFAULT_DOCKER_FOLDER = join(import.meta.dirname, "..", "..", "docker");
const dockerfile = (folder: string) => join(folder, "atelier.Dockerfile");
const HASH_LABEL = "webaios.dockerfile";

/** Hash of the Dockerfile: the image and the container carry it as a label, to know whether they are up to date. */
export function dockerfileHash(dockerFolder = DEFAULT_DOCKER_FOLDER): string {
  return createHash("sha256").update(readFileSync(dockerfile(dockerFolder))).digest("hex").slice(0, 12);
}

function normalize(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * Name of a run's container: `webaios-recolte-<id>` for a widget (a bare id is a widget's),
 * `webaios-action-<id>` for an action. The id goes into a docker name, any dubious id is refused.
 */
export function harvestName(p: string | Owner): string {
  const { type, id } = typeof p === "string" ? { type: "widget" as const, id: p } : p;
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`id ${type === "widget" ? "de widget" : "d'action"} invalide : ${id}`);
  return type === "widget" ? `webaios-recolte-${id}` : `webaios-action-${id}`;
}

/** Maximum duration of a harvest in its container (seconds), before SIGTERM then SIGKILL 5 s later. */
export const HARVEST_DELAY_S = 180;

/** An app's folder goes into a grep expression between apostrophes: any dubious name is refused. */
function appFolder(folder: string): string {
  if (!validFolder(folder)) throw new Error(`dossier d'application invalide : ${folder}`);
  return folder;
}

export type WorkshopState = "docker-absent" | "absent" | "arrete" | "demarre";

/** Looks for the docker CLI in the PATH then at known locations (Finder does not have the shell's PATH). */
export function findDocker(
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
): string | null {
  const candidates = [
    ...(env.PATH ?? "").split(":").filter(Boolean).map((d) => join(d, "docker")),
    "/usr/local/bin/docker",
    "/opt/homebrew/bin/docker",
    ...(env.HOME ? [join(env.HOME, ".orbstack", "bin", "docker"), join(env.HOME, ".docker", "bin", "docker")] : []),
    "/Applications/Docker.app/Contents/Resources/bin/docker",
  ];
  return candidates.find((c) => exists(c)) ?? null;
}

function sessionFile(id: string): string {
  if (!/^[a-z0-9]+$/.test(id)) throw new Error(`id de session invalide : ${id}`);
  return `/tmp/webaios-session-${id}.pid`;
}

/** Variable set on each session: everything the agent launches inherits it, even detached from its group (nohup, setsid). */
export const VARIABLE_SESSION = "WEBAIOS_SESSION";

/**
 * Sends HUP, then TERM, then KILL to the processes listed by the shell function `cibles` (pid, or -pgid for a group).
 * claude intercepts HUP and TERM without necessarily quitting: each signal has 2 s to act.
 */
function escalate(targets: string): string[] {
  return [
    `cibles() { ${targets}; }`,
    // No « -- »: the kill of dash (the container's sh) refuses it, and the group would never be targeted.
    `signaler() { for c in $(cibles); do kill -$1 "$c" 2>/dev/null; done; }`,
    `vivant() { for c in $(cibles); do kill -0 "$c" 2>/dev/null && return 0; done; return 1; }`,
    `for s in HUP TERM; do signaler $s; i=0; while [ $i -lt 20 ] && vivant; do sleep 0.1; i=$((i + 1)); done; vivant || exit 0; done`,
    `signaler KILL`,
  ];
}

/** Processes that carry the mark `motif` (grep expression on a whole environment variable). */
const marks = (pattern: string) =>
  `for d in /proc/[0-9]*; do grep -qzx '${pattern}' "$d/environ" 2>/dev/null && echo "\${d#/proc/}"; done`;

/** A text read as is by grep (basic expression): « my.app » does not target « myxapp ». */
const literal = (text: string) => text.replace(/[\\.*[\]^$]/g, "\\$&");

/**
 * Stops session `id` whose PID is noted in `f`: its group (the agent and what it launched), and any process
 * that carries its mark (a demo server detached by the agent).
 */
export function sessionStopScript(f: string, id: string): string {
  return [
    `p=$(cat ${f} 2>/dev/null) || p=`,
    `rm -f ${f}`,
    ...escalate(`[ -n "$p" ] && echo "-$p $p"; ${marks(`${VARIABLE_SESSION}=${id}`)}`),
  ].join("\n");
}

/** Stops all marked sessions, whatever their window (see arreterSessionsOrphelines). */
export function orphanStopScript(): string {
  return ["rm -f /tmp/webaios-session-*.pid", ...escalate(marks(`${VARIABLE_SESSION}=.*`))].join("\n");
}

/** Mark of the processes of a launched app: never confused with that of sessions (`WEBAIOS_SESSION`). */
export const VARIABLE_APPLICATION = "WEBAIOS_APP";

export class Workshop {
  private readonly chemins: SpacePaths;
  private readonly executer: Runner;
  private readonly docker: string | null;
  private readonly dossierDocker: string;
  /** Startup in progress, shared: two windows opening an agent do not build the image twice. */
  private demarrage: Promise<WorkshopState> | null = null;

  constructor(o: { chemins: SpacePaths; executer?: Runner; docker?: string | null; dossierDocker?: string }) {
    this.dossierDocker = o.dossierDocker ?? DEFAULT_DOCKER_FOLDER;
    this.chemins = o.chemins;
    this.executer = o.executer ?? defaultRunner;
    this.docker = o.docker === undefined ? findDocker() : o.docker;
  }

  private lancer(args: string[], delayMs?: number) {
    return this.executer(this.docker!, args, delayMs ? { delaiMs: delayMs } : undefined);
  }

  async etat(): Promise<WorkshopState> {
    if (!this.docker || (await this.lancer(["info"], PROBE_DELAY_MS)).code !== 0) return "docker-absent";
    const r = await this.lancer(["inspect", "-f", "{{.State.Running}}", containerName()], PROBE_DELAY_MS);
    if (r.code !== 0) return "absent";
    return r.stdout.trim() === "true" ? "demarre" : "arrete";
  }

  /** Is the existing container mounted on the right root and built from the current Dockerfile? */
  private async conteneurAJour(hash: string): Promise<boolean> {
    const format = `{{range .Mounts}}{{if eq .Destination "${CONTAINER_PATH}"}}{{.Source}}{{end}}{{end}}|{{index .Config.Labels "${HASH_LABEL}"}}`;
    const r = await this.lancer(["inspect", "-f", format, containerName()], PROBE_DELAY_MS);
    const [source = "", label = ""] = r.stdout.trim().split("|");
    return r.code === 0 && normalize(source) === normalize(this.chemins.racine) && label === hash;
  }

  assurerDemarre(): Promise<WorkshopState> {
    this.demarrage ??= this.demarrer().finally(() => (this.demarrage = null));
    return this.demarrage;
  }

  private async demarrer(): Promise<WorkshopState> {
    let state = await this.etat();
    if (state === "docker-absent") return state;
    const hash = dockerfileHash(this.dossierDocker);
    // A container created on another folder or with an old Dockerfile is recreated; /workspace and
    // the credentials volume are kept, only the container layer is lost.
    if (state !== "absent" && !(await this.conteneurAJour(hash))) {
      await this.lancer(["rm", "-f", containerName()], PROBE_DELAY_MS);
      state = "absent";
    }
    if (state === "demarre") return state;
    if (state === "arrete") {
      await this.lancer(["start", containerName()], PROBE_DELAY_MS);
      return this.etat();
    }
    const image = await this.lancer(["image", "inspect", "-f", `{{index .Config.Labels "${HASH_LABEL}"}}`, IMAGE], PROBE_DELAY_MS);
    if (image.code !== 0 || image.stdout.trim() !== hash) {
      const build = await this.lancer(["build", "-t", IMAGE, "--label", `${HASH_LABEL}=${hash}`, "-f", dockerfile(this.dossierDocker), this.dossierDocker], BUILD_DELAY_MS);
      if (build.code !== 0) throw new Error(`Construction de l'image ${IMAGE} impossible : ${build.stderr}`);
    }
    const ports = containerPortRange().join("-");
    const run = await this.lancer([
      "run", "-d",
      "--name", containerName(),
      "--add-host", "host.docker.internal:host-gateway",
      "-v", `${this.chemins.racine}:${CONTAINER_PATH}`,
      "-v", `${VOLUME_HOME}:/home/node`,
      "-p", `127.0.0.1:${ports}:${ports}`,
      // AGENTS.md tells the agent to keep its hand-run servers in this range.
      "-e", `WEBAIOS_PORTS=${ports}`,
      "-w", CONTAINER_PATH,
      IMAGE,
      "sleep", "infinity",
    ], PROBE_DELAY_MS);
    if (run.code !== 0) {
      // A failed run (port already taken…) can leave the container created without network: the next start must not reuse it.
      await this.lancer(["rm", "-f", containerName()], PROBE_DELAY_MS);
      throw new Error(`Démarrage du conteneur ${containerName()} impossible : ${run.stderr}`);
    }
    return this.etat();
  }

  /**
   * Run of a workflow, in a disposable container with no network: it sees only the files folder and the
   * engine folder (that of the harvester and its modules), read-only, and talks to the kernel only through its standard input and
   * output (`-i`). `delaiS`: the container is stopped after this delay (+5 s to finish).
   */
  commandeRecolte(owner: string | Owner, filesFolder: string, engine: string, delayS: number = HARVEST_DELAY_S): string[] {
    if (!this.docker) throw new Error("Docker introuvable");
    // « : » would change the meaning of -v (target, options): such a path cannot be mounted safely.
    for (const c of [filesFolder, engine]) if (c.includes(":")) throw new Error(`chemin non montable : ${c}`);
    return [
      this.docker, "run", "-i", "--rm",
      "--name", harvestName(owner),
      "--network", "none",
      "--read-only",
      "--tmpfs", "/tmp",
      "-v", `${filesFolder}:/widget:ro`,
      "-v", `${engine}:/opt/webaios/moteur:ro`,
      "--memory", "512m",
      "--pids-limit", "128",
      IMAGE,
      "timeout", "-k", "5", String(delayS),
      "node", "/opt/webaios/moteur/recolteur.mjs", "/widget",
    ];
  }

  /** Killing the `docker run` client is not enough: the container is force-deleted. */
  async supprimerRecolte(owner: string | Owner): Promise<void> {
    if (this.docker) await this.lancer(["rm", "-f", harvestName(owner)], PROBE_DELAY_MS);
  }

  /**
   * Interactive agent session: the shell notes its PID in the container before becoming the agent (exec), so
   * that `arreterSession` can kill it there. Killing the local `docker exec` client would leave the agent running.
   */
  commandeSession(id: string, argv: string[]): string[] {
    const f = sessionFile(id);
    return this.commandeExec(["sh", "-c", `echo $$ > ${f}; exec "$@"`, "webaios-session", ...argv], { interactif: true, env: { [VARIABLE_SESSION]: id } });
  }

  async arreterSession(id: string): Promise<void> {
    if (!this.docker) return;
    await this.lancer(["exec", containerName(), "sh", "-c", sessionStopScript(sessionFile(id), id)], PROBE_DELAY_MS);
  }

  /**
   * At app launch: the agents (and their servers) of a previous app that could not stop them (killed outright,
   * crashed) have no window anymore. Only one app runs at a time on the workshop.
   */
  async arreterSessionsOrphelines(): Promise<void> {
    if (this.docker) await this.lancer(["exec", containerName(), "sh", "-c", orphanStopScript()], PROBE_DELAY_MS);
  }

  /**
   * Application of a project, launched in its folder with its mark and its port. The shell redirects everything to the
   * log (rewritten at each launch) then evaluates the manifest's command: the folder and the command go as
   * arguments ($1, $2), never pasted into the script.
   */
  commandeApplication(folder: string, command: string, port: number): string[] {
    appFolder(folder);
    const logs = `${CONTAINER_PATH}/.webaios/journaux`;
    return this.commandeExec(
      ["sh", "-c", `mkdir -p ${logs}; exec >"${logs}/$1.log" 2>&1; eval "$2"`, "webaios-app", folder, command.replaceAll("{port}", String(port))],
      { interactif: false, env: { [VARIABLE_APPLICATION]: folder, PORT: String(port) }, dossier: `${CONTAINER_PATH}/projets/${folder}` },
    );
  }

  /** Stops app `dossier`: any process that carries its mark, even detached from the shell that launched it. */
  async arreterApplication(folder: string): Promise<void> {
    if (this.docker) await this.lancer(["exec", containerName(), "sh", "-c", escalate(marks(`${VARIABLE_APPLICATION}=${literal(appFolder(folder))}`)).join("\n")], PROBE_DELAY_MS);
  }

  /** At browser launch: apps of a previous life have nobody left to follow them. */
  async arreterApplicationsOrphelines(): Promise<void> {
    if (this.docker) await this.lancer(["exec", containerName(), "sh", "-c", escalate(marks(`${VARIABLE_APPLICATION}=.*`)).join("\n")], PROBE_DELAY_MS);
  }

  commandeExec(argv: string[], o: { interactif: boolean; env?: Record<string, string>; dossier?: string }): string[] {
    if (!this.docker) throw new Error("Docker introuvable");
    const env = Object.entries(o.env ?? {}).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
    return [this.docker, "exec", ...(o.interactif ? ["-it"] : []), ...env, "-w", o.dossier ?? CONTAINER_PATH, containerName(), ...argv];
  }
}
