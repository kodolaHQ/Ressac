import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { validFolder } from "../applications/manifest.js";
import { CONTAINER_PATH, KERNEL_ROOT, type SpacePaths } from "../paths.js";
import type { Owner } from "../workflows/schema.js";
import { say } from "../i18n.js";
import { portRange } from "./ports.js";
import { createRunner, type RunResult, type Runner } from "./runner.js";

export const CONTAINER_NAME = "ressac-workshop";
// Read on every call so a second app (Firefox build) can run its own container.
export const containerName = (): string => process.env.RESSAC_CONTAINER || CONTAINER_NAME;
export const IMAGE = "ressac-workshop:1";
/** Read for the container created before the rename to Ressac: `webaios-<rest>` for `ressac-<rest>`. */
export const LEGACY_CONTAINER_PREFIX = "webaios-";
const legacyContainer = (): string | null => {
  const name = containerName();
  return name.startsWith("ressac-") ? LEGACY_CONTAINER_PREFIX + name.slice("ressac-".length) : null;
};
// Stored format kept across the rename to Ressac: a Docker volume cannot be renamed, and this one holds the agent's logins.
export const VOLUME_HOME = "webaios-home";
/**
 * Ports published by the container, the same on the Mac and inside: 5280-5299 by default, out of Vite's range (5173…).
 * Two containers cannot publish the same ports, so a second app (Firefox build) sets RESSAC_CONTAINER_PORTS (`min-max`).
 * Read on every call, like containerName().
 */
export function containerPortRange(): [number, number] {
  return portRange(process.env.RESSAC_CONTAINER_PORTS);
}
/** The docker probes must not block if Docker Desktop is stuck at startup. */
const PROBE_DELAY_MS = 30_000;
/** First build: download of the base image and install of the agent. Beyond that, it is blocked. */
export const BUILD_DELAY_MS = 20 * 60_000;

/** The end of a build output: the error is there, the rest would flood the page that shows it. */
const tail = (s: string): string => s.trim().split("\n").slice(-3).join("\n").slice(-300);

export interface BuildProgress {
  step: number;
  of: number;
  label: string;
  /** Epoch ms of the build's start, so that every window counts the same minutes. */
  since: number;
}

/** What a BuildKit plain-progress line says (`#5 [2/3] RUN apt-get …`), or null for any other line. */
export function parseBuildStep(line: string, locale: string): Pick<BuildProgress, "step" | "of" | "label"> | null {
  const m = /^#\d+ \[(?:[\w-]+ )?(\d+)\/(\d+)\] (FROM|RUN) (.*)$/.exec(line.trim());
  if (!m) return null;
  const label =
    m[3] === "FROM" ? say(locale, "kernel-build-base-image")
    : m[4]!.includes("apt-get") ? say(locale, "kernel-build-system-tools")
    : m[4]!.includes("claude-code") ? say(locale, "kernel-build-claude-codex")
    : say(locale, "kernel-build-preparing");
  return { step: Number(m[1]), of: Number(m[2]), label };
}

const CODEX_REQUIREMENTS = "/etc/codex/requirements.toml";
/** Codex's managed requirements (root-owned): the URL must match exactly, port included, so it is written per session. */
export function codexRequirements(url: string): string {
  return `allow_managed_hooks_only = true\n\n[mcp_servers.ressac.identity]\nurl = ${JSON.stringify(url)}\n`;
}

/**
 * Bumped with any change to RUN_FLAGS or to the `docker run` mounts: it goes into the image hash, so the container is
 * recreated (the fake docker of the e2e tests repeats it).
 */
export const RUN_FLAGS_VERSION = "4";
/** The network, memory and proxy flags of `docker run` (the part after the ports). */
export const RUN_FLAGS = [
  "--cap-add", "NET_ADMIN",
  // No setuid route to root for the agent: root alone (docker exec -u root) applies the network rules.
  "--security-opt", "no-new-privileges",
  "--memory", "4g",
  "--pids-limit", "1024",
  "--sysctl", "net.ipv6.conf.all.disable_ipv6=1",
  ...["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"].flatMap((k) => ["-e", `${k}=http://127.0.0.1:3128`]),
  ...["NO_PROXY", "no_proxy"].flatMap((k) => ["-e", `${k}=localhost,127.0.0.1,host.docker.internal`]),
  "-e", "NODE_USE_ENV_PROXY=1",
  "-e", "DISABLE_AUTOUPDATER=1",
  "-e", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1",
];

/** Dockerfile folder in the package; a browser that embeds the kernel can provide another. */
export const DEFAULT_DOCKER_FOLDER = join(KERNEL_ROOT, "docker");
const dockerfile = (folder: string) => join(folder, "workshop.Dockerfile");
const HASH_LABEL = "ressac.dockerfile";

/** Hash of the Dockerfile: the image and the container carry it as a label, to know whether they are up to date. */
export function dockerfileHash(dockerFolder = DEFAULT_DOCKER_FOLDER): string {
  const hash = createHash("sha256").update(readFileSync(dockerfile(dockerFolder)));
  // The network module is copied into the image, and the run flags live in the container: a change to either must rebuild.
  const network = join(dockerFolder, "ressac-network.mjs");
  if (existsSync(network)) hash.update(readFileSync(network));
  return hash.update(`flags-${RUN_FLAGS_VERSION}`).digest("hex").slice(0, 12);
}

function normalize(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * Name of a run's container: `ressac-harvest-<id>` for a widget (a bare id is a widget's),
 * `ressac-action-<id>` for an action. The id goes into a docker name, any dubious id is refused.
 */
export function harvestName(p: string | Owner): string {
  const { type, id } = typeof p === "string" ? { type: "widget" as const, id: p } : p;
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`id ${type === "widget" ? "de widget" : "d'action"} invalide : ${id}`);
  return type === "widget" ? `ressac-harvest-${id}` : `ressac-action-${id}`;
}

/** Maximum duration of a harvest in its container (seconds), before SIGTERM then SIGKILL 5 s later. */
export const HARVEST_DELAY_S = 180;

/** An app's folder goes into a grep expression between apostrophes: any dubious name is refused. */
function appFolder(folder: string): string {
  if (!validFolder(folder)) throw new Error(`dossier d'application invalide : ${folder}`);
  return folder;
}

/** Same syntax as docker/ressac-network.mjs, which runs as root in the image (a test keeps both in agreement). */
export function validDomain(d: string): boolean {
  if (typeof d !== "string" || d.length === 0 || d.length > 253) return false;
  const name = d.startsWith("*.") ? d.slice(2) : d;
  const labels = name.split(".");
  return labels.length >= 2 && labels.every((l) => /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(l) && l.length <= 63) && !/^[0-9.]+$/.test(name);
}

export interface AgentNetwork {
  ports: number[];
  domains: string[];
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
  return `/tmp/ressac-session-${id}.pid`;
}

/** Variable set on each session: everything the agent launches inherits it, even detached from its group (nohup, setsid). */
export const VARIABLE_SESSION = "RESSAC_SESSION";

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
  return ["rm -f /tmp/ressac-session-*.pid", ...escalate(marks(`${VARIABLE_SESSION}=.*`))].join("\n");
}

/** Mark of the processes of a launched app: never confused with that of sessions (`RESSAC_SESSION`). */
export const VARIABLE_APPLICATION = "RESSAC_APP";

export class Workshop {
  private readonly paths: SpacePaths;
  private readonly run: Runner;
  private found: string | null = null;
  private readonly lookup: () => string | null;
  /** Looked up again while absent: Docker installed after the app started is found without a restart. */
  private get docker(): string | null {
    return (this.found ??= this.lookup());
  }
  private readonly dockerFolder: string;
  private readonly locale: () => string;
  private readonly network: (() => AgentNetwork) | undefined;
  private securing: Promise<void> | null = null;
  private applying = "";
  /** The rules are known to be in place since the container's last start. */
  private secured = false;
  private followUp: Promise<void> | null = null;
  /** Startup in progress, shared: two windows opening an agent do not build the image twice. */
  private startup: Promise<WorkshopState> | null = null;
  /** Rebuild in progress, shared: two rebuilds at once build once. */
  private rebuilding: Promise<WorkshopState> | null = null;
  /** The build's latest step, replayed to a window that subscribes mid-build; null outside a build. */
  private progress: BuildProgress | null = null;
  private readonly listeners = new Set<(p: BuildProgress) => void>();

  constructor(o: { paths: SpacePaths; run?: Runner; docker?: string | null; findDocker?: () => string | null; dockerFolder?: string; locale?: () => string; network?: () => AgentNetwork }) {
    this.network = o.network;
    this.locale = o.locale ?? (() => "en");
    this.dockerFolder = o.dockerFolder ?? DEFAULT_DOCKER_FOLDER;
    this.paths = o.paths;
    this.run = o.run ?? createRunner(this.locale);
    this.lookup = o.docker === undefined ? (o.findDocker ?? findDocker) : () => o.docker ?? null;
  }

  private launch(args: string[], delayMs?: number, input?: string) {
    return this.run(this.docker!, args, { ...(delayMs ? { delayMs } : {}), ...(input !== undefined ? { input } : {}) });
  }

  /** Every window waiting on the shared start hears the build's steps. Returns the unsubscribe. */
  onBuildProgress(listener: (p: BuildProgress) => void): () => void {
    this.listeners.add(listener);
    if (this.progress) listener(this.progress);
    return () => this.listeners.delete(listener);
  }

  /** The build streams its stderr (BuildKit plain progress) instead of waiting for the end. */
  private async build(args: string[]): Promise<RunResult> {
    const since = Date.now();
    let pending = "";
    const onStderr = (chunk: string) => {
      const lines = (pending + chunk).split("\n");
      pending = lines.pop()!;
      for (const line of lines) {
        const step = parseBuildStep(line, this.locale());
        if (!step) continue;
        this.progress = { ...step, since };
        for (const l of this.listeners) l(this.progress);
      }
    };
    try {
      return await this.run(this.docker!, args, { delayMs: BUILD_DELAY_MS, onStderr });
    } finally {
      this.progress = null;
    }
  }

  async state(): Promise<WorkshopState> {
    if (!this.docker || (await this.launch(["info"], PROBE_DELAY_MS)).code !== 0) return "docker-absent";
    const r = await this.launch(["inspect", "-f", "{{.State.Running}}", containerName()], PROBE_DELAY_MS);
    if (r.code !== 0) return "absent";
    return r.stdout.trim() === "true" ? "demarre" : "arrete";
  }

  /** Is the existing container mounted on the right root and built from the current Dockerfile? */
  private async containerUpToDate(hash: string): Promise<boolean> {
    const format = `{{range .Mounts}}{{if eq .Destination "${CONTAINER_PATH}"}}{{.Source}}{{end}}{{end}}|{{index .Config.Labels "${HASH_LABEL}"}}`;
    const r = await this.launch(["inspect", "-f", format, containerName()], PROBE_DELAY_MS);
    const [source = "", label = ""] = r.stdout.trim().split("|");
    return r.code === 0 && normalize(source) === normalize(this.paths.root) && label === hash;
  }

  ensureStarted(): Promise<WorkshopState> {
    this.startup ??= this.start().finally(() => (this.startup = null));
    return this.startup;
  }

  /** Stops the container (volumes kept) and starts it again. */
  async restart(): Promise<WorkshopState> {
    if (!this.docker || (await this.launch(["info"], PROBE_DELAY_MS)).code !== 0) return "docker-absent";
    await this.launch(["stop", "-t", "2", containerName()], PROBE_DELAY_MS);
    return this.ensureStarted();
  }

  /** Deletes the container and rebuilds the image from scratch; /workspace and the home volume are kept. */
  async rebuild(): Promise<WorkshopState> {
    if (!this.docker || (await this.launch(["info"], PROBE_DELAY_MS)).code !== 0) return "docker-absent";
    this.rebuilding ??= (async () => {
      // A plain startup in progress (an agent opening) ends first: the rebuild never rides on it.
      while (this.startup) await this.startup.catch(() => {});
      this.startup = (async () => {
        await this.launch(["rm", "-f", containerName()], PROBE_DELAY_MS);
        return this.start({ fresh: true });
      })().finally(() => (this.startup = null));
      return this.startup;
    })().finally(() => (this.rebuilding = null));
    return this.rebuilding;
  }

  /** One-off command in the container, not interactive. */
  async exec(argv: string[]): Promise<RunResult> {
    if (!this.docker) return { code: 1, stdout: "", stderr: "Docker introuvable" };
    // The agent CLIs run as the agent-writable user: never before the rules exist.
    if (!this.secured) await this.secureNetwork();
    return this.launch(["exec", containerName(), ...argv], PROBE_DELAY_MS);
  }

  /** Before each Codex session: only managed hooks, and no MCP server but Ressac's at `url` (a stdio server runs a command). */
  async restrictCodex(url: string): Promise<void> {
    // umask: docker exec runs with 000, which would leave the file writable by the agent.
    const r = await this.launch(
      ["exec", "-u", "root", "-w", "/", "-i", containerName(), "sh", "-c", `umask 022 && cat > ${CODEX_REQUIREMENTS}.$$ && mv ${CODEX_REQUIREMENTS}.$$ ${CODEX_REQUIREMENTS}`],
      PROBE_DELAY_MS,
      codexRequirements(url),
    );
    if (r.code !== 0) throw new Error(`Restriction de Codex impossible : ${tail(r.stderr) || `code ${r.code}`}`);
  }

  /** One run at a time, shared: two sessions opening together apply the rules once. */
  secureNetwork(): Promise<void> {
    if (!this.network) return Promise.resolve();
    if (!this.securing) {
      this.securing = this.applyNetwork().finally(() => (this.securing = null));
      return this.securing;
    }
    // Same rules as the running apply read: share it. Otherwise one follow-up (shared by later calls) reads them again.
    if (JSON.stringify(this.network()) === this.applying) return this.securing;
    this.followUp ??= this.securing
      .catch(() => {})
      .then(() => {
        this.followUp = null;
        return this.secureNetwork();
      });
    return this.followUp;
  }

  /**
   * Installs the network rules and the proxy (as root, JSON on stdin) then checks the web is really closed.
   * Called before every agent session: a restarted container has no rules. Throws if either step fails.
   */
  private async applyNetwork(): Promise<void> {
    const fail = (error: string): never => {
      throw new Error(say(this.locale(), "kernel-network-failed", { error }));
    };
    // The rules in place are unknown until this run succeeds: exec applies them again first.
    this.secured = false;
    const rules = this.network!();
    this.applying = JSON.stringify(rules);
    const { ports, domains } = rules;
    const apply = await this.launch(
      ["exec", "-u", "root", "-w", "/", "-i", containerName(), "node", "/opt/ressac/ressac-network.mjs", "apply"],
      PROBE_DELAY_MS,
      JSON.stringify({ ports, domains: domains.filter(validDomain) }),
    );
    if (apply.code !== 0) fail(tail(apply.stderr) || `code ${apply.code}`);
    const probe = await this.launch(["exec", containerName(), "curl", "-s", "--noproxy", "*", "--max-time", "3", "https://1.1.1.1"], PROBE_DELAY_MS);
    // Only « refused » (7) proves the direct path is shut; anything else (reachable, TLS error, timeout, no curl…) is not proof.
    if (probe.code !== 7) fail(say(this.locale(), "kernel-network-open", { code: probe.code }));
    this.secured = true;
  }

  private async start(o: { fresh?: boolean } = {}): Promise<WorkshopState> {
    this.secured = false;
    const state = await this.startContainer(o);
    // A failed apply leaves `secured` false: exec retries it and refuses to run until it succeeds.
    if (state === "demarre") await this.secureNetwork().catch(() => {});
    return state;
  }

  private async startContainer(o: { fresh?: boolean }): Promise<WorkshopState> {
    let state = await this.state();
    if (state === "docker-absent") return state;
    const hash = dockerfileHash(this.dockerFolder);
    // A container created on another folder or with an old Dockerfile is recreated; /workspace and
    // the credentials volume are kept, only the container layer is lost.
    if (state !== "absent" && !(await this.containerUpToDate(hash))) {
      await this.launch(["rm", "-f", containerName()], PROBE_DELAY_MS);
      state = "absent";
    }
    if (state === "demarre") return state;
    if (state === "arrete") {
      await this.launch(["start", containerName()], PROBE_DELAY_MS);
      return this.state();
    }
    const image = await this.launch(["image", "inspect", "-f", `{{index .Config.Labels "${HASH_LABEL}"}}`, IMAGE], PROBE_DELAY_MS);
    if (o.fresh || image.code !== 0 || image.stdout.trim() !== hash) {
      // No --progress flag: the classic builder rejects it, and BuildKit already prints plain steps without a TTY.
      const build = await this.build(["build", ...(o.fresh ? ["--no-cache", "--pull"] : []), "-t", IMAGE, "--label", `${HASH_LABEL}=${hash}`, "-f", dockerfile(this.dockerFolder), this.dockerFolder]);
      if (build.code !== 0) throw new Error(`Construction de l'image ${IMAGE} impossible : ${tail(build.stderr)}`);
    }
    const ports = containerPortRange().join("-");
    // The container from before the rename publishes the same ports: removed (absent: docker says so, nothing more).
    const old = legacyContainer();
    if (old) await this.launch(["rm", "-f", old], PROBE_DELAY_MS);
    const run = await this.launch([
      "run", "-d",
      "--name", containerName(),
      "--add-host", "host.docker.internal:host-gateway",
      "-v", `${this.paths.root}:${CONTAINER_PATH}`,
      // .ressac holds what restricts the agent (launch profiles, MCP configs): read-only, and a mount point cannot be renamed
      // away. Only the logs, which the apps write from the container, are writable (initSpace creates both folders).
      // The instruction files stay writable on purpose: the CLIs load many override files the agent could write anyway.
      "-v", `${this.paths.internal}:${CONTAINER_PATH}/.ressac:ro`,
      "-v", `${this.paths.logs}:${CONTAINER_PATH}/.ressac/logs`,
      "-v", `${VOLUME_HOME}:/home/node`,
      "-p", `127.0.0.1:${ports}:${ports}`,
      // AGENTS.md tells the agent to keep its hand-run servers in this range.
      "-e", `RESSAC_PORTS=${ports}`,
      // The agent reaches the web only through the allowlist proxy (see secureNetwork); the rules need NET_ADMIN.
      ...RUN_FLAGS,
      "-w", CONTAINER_PATH,
      IMAGE,
      "sleep", "infinity",
    ], PROBE_DELAY_MS);
    if (run.code !== 0) {
      // A failed run (port already taken…) can leave the container created without network: the next start must not reuse it.
      await this.launch(["rm", "-f", containerName()], PROBE_DELAY_MS);
      throw new Error(say(this.locale(), "kernel-container-start-failed", { name: containerName(), error: run.stderr }));
    }
    return this.state();
  }

  /**
   * Run of a workflow, in a disposable container with no network: it sees only the files folder and the
   * engine folder (that of the harvester and its modules), read-only, and talks to the kernel only through its standard input and
   * output (`-i`). `delayS`: the container is stopped after this delay (+5 s to finish).
   */
  harvestCommand(owner: string | Owner, filesFolder: string, engine: string, delayS: number = HARVEST_DELAY_S): string[] {
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
      "-v", `${engine}:/opt/ressac/engine:ro`,
      "--memory", "512m",
      "--pids-limit", "128",
      "--cpus", "1",
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges",
      IMAGE,
      "timeout", "-k", "5", String(delayS),
      "node", "/opt/ressac/engine/harvester.mjs", "/widget",
    ];
  }

  /** Killing the `docker run` client is not enough: the container is force-deleted. */
  async deleteHarvest(owner: string | Owner): Promise<void> {
    if (this.docker) await this.launch(["rm", "-f", harvestName(owner)], PROBE_DELAY_MS);
  }

  /**
   * Interactive agent session: the shell notes its PID in the container before becoming the agent (exec), so
   * that `stopSession` can kill it there. Killing the local `docker exec` client would leave the agent running.
   */
  sessionCommand(id: string, argv: string[], passEnv: string[] = []): string[] {
    const f = sessionFile(id);
    return this.execCommand(["sh", "-c", `echo $$ > ${f}; exec "$@"`, "ressac-session", ...argv], { interactive: true, env: { [VARIABLE_SESSION]: id }, passEnv: passEnv });
  }

  async stopSession(id: string): Promise<void> {
    if (!this.docker) return;
    await this.launch(["exec", containerName(), "sh", "-c", sessionStopScript(sessionFile(id), id)], PROBE_DELAY_MS);
  }

  /**
   * Before a session when none runs: every process of the agent's user but the container's PID 1 is killed. A process the
   * agent detached with a new group and an empty environment (`setsid env -i …`) escapes both marks of `stopSession` and
   * would keep reading `.ressac` tokens for later conversations. The apps it launched go too.
   */
  async stopAgentProcesses(): Promise<void> {
    if (!this.docker) return;
    const r = await this.launch(["exec", "-u", "node", containerName(), "sh", "-c", "kill -KILL -1 2>/dev/null; true"], PROBE_DELAY_MS);
    if (r.code !== 0) throw new Error(`Arrêt des processus de l'agent impossible : ${tail(r.stderr) || `code ${r.code}`}`);
  }

  /**
   * At app launch: the agents (and their servers) of a previous app that could not stop them (killed outright,
   * crashed) have no window anymore. Only one app runs at a time on the workshop.
   */
  async stopOrphanSessions(): Promise<void> {
    if (this.docker) await this.launch(["exec", containerName(), "sh", "-c", orphanStopScript()], PROBE_DELAY_MS);
  }

  /**
   * Application of a project, launched in its folder with its mark and its port. The shell redirects everything to the
   * log (rewritten at each launch) then evaluates the manifest's command: the folder and the command go as
   * arguments ($1, $2), never pasted into the script.
   */
  appCommand(folder: string, command: string, port: number): string[] {
    appFolder(folder);
    const logs = `${CONTAINER_PATH}/.ressac/logs`;
    return this.execCommand(
      ["sh", "-c", `mkdir -p ${logs}; exec >"${logs}/$1.log" 2>&1; eval "$2"`, "ressac-app", folder, command.replaceAll("{port}", String(port))],
      { interactive: false, env: { [VARIABLE_APPLICATION]: folder, PORT: String(port) }, folder: `${CONTAINER_PATH}/projects/${folder}` },
    );
  }

  /** Stops app `dossier`: any process that carries its mark, even detached from the shell that launched it. */
  async stopApp(folder: string): Promise<void> {
    if (this.docker) await this.launch(["exec", containerName(), "sh", "-c", escalate(marks(`${VARIABLE_APPLICATION}=${literal(appFolder(folder))}`)).join("\n")], PROBE_DELAY_MS);
  }

  /** At browser launch: apps of a previous life have nobody left to follow them. */
  async stopOrphanApps(): Promise<void> {
    if (this.docker) await this.launch(["exec", containerName(), "sh", "-c", escalate(marks(`${VARIABLE_APPLICATION}=.*`)).join("\n")], PROBE_DELAY_MS);
  }

  /** `passEnv`: names only (`-e NAME`), the value comes from the caller's environment, so a token never shows in the arguments. */
  execCommand(argv: string[], o: { interactive: boolean; env?: Record<string, string>; passEnv?: string[]; folder?: string }): string[] {
    if (!this.docker) throw new Error("Docker introuvable");
    const env = Object.entries(o.env ?? {}).flatMap(([k, v]) => ["-e", `${k}=${v}`]).concat((o.passEnv ?? []).flatMap((k) => ["-e", k]));
    return [this.docker, "exec", ...(o.interactive ? ["-it"] : []), ...env, "-w", o.folder ?? CONTAINER_PATH, containerName(), ...argv];
  }
}
