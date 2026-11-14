import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { request } from "node:http";
import { join } from "node:path";
import { say } from "../i18n.js";
import type { SpacePaths } from "../paths.js";
import { containerPortRange, type Workshop } from "../container/workshop.js";
import { validFolder, readProjects, watchProjects, type ProjectRead } from "./manifest.js";

/** Time an app has to answer on its port before « En erreur ». */
export const READY_DELAY_MS = 60_000;
const PROBE_INTERVAL_MS = 250;
const ERROR_LINES = 20;

/** `preparation`: the container starts. */
export type AppState = "stopped" | "preparing" | "launching" | "running" | "error";

export interface Application {
  folder: string;
  name: string;
  type: "app" | "poc" | "no-manifest";
  origin?: string;
  noManifest?: string;
  createdAt: string;
  state: AppState;
  port?: number;
  error?: string;
}

/** Launches an app's `docker exec` client; argv[0] is the docker CLI. */
export type Launcher = (argv: string[]) => { onEnd(r: (code: number | null) => void): void; kill(): void };

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
  return { onEnd: (r) => callbacks.push(r), kill: () => p.kill() };
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

type Outcome = { type: "ready" } | { type: "end"; code: number | null } | { type: "timeout" } | { type: "stop" };

/** A launch in progress or running. `arret`: the stop was requested, the end of the process is no longer an error. */
interface Launch {
  stop: boolean;
  process?: ReturnType<Launcher>;
  wake?: (i: Outcome) => void;
}

interface Tracking {
  state: AppState;
  port?: number;
  error?: string;
  launch?: Launch;
}

export class ApplicationManager {
  private readonly locale: () => string;
  private readonly paths: SpacePaths;
  private readonly workshop: Workshop;
  private readonly launcher: Launcher;
  private readonly ports: [number, number];
  private readonly readyDelayMs: number;
  private readonly probeIntervalMs: number;
  private readonly probe: (port: number) => Promise<"http" | "occupe" | "libre">;
  private readonly onChange: () => void;
  private readonly tracked = new Map<string, Tracking>();
  /** Last launch requested per folder: two launches of the same app follow each other. */
  private readonly files = new Map<string, Promise<unknown>>();
  /**
   * Number of stops requested per folder. A launch notes this number when requested: if it changed when the
   * launch really starts (waiting in the queue, reading projects), the stop targeted it too.
   */
  private readonly stops = new Map<string, number>();
  private watchEnd?: () => Promise<void>;
  /**
   * Stop scripts in progress per folder, and cleanup of orphans at startup: they target processes by their
   * mark, at each signal. A launch awaits them before starting its process, otherwise it would be killed with the old one.
   */
  private readonly stopsRunning = new Map<string, Promise<void>>();
  private paced: Promise<void> = Promise.resolve();

  constructor(o: {
    paths: SpacePaths;
    workshop: Workshop;
    launcher?: Launcher;
    ports?: [number, number];
    readyDelayMs?: number;
    /** For tests: the gap between two port probes. */
    probeIntervalMs?: number;
    probe?: (port: number) => Promise<"http" | "occupe" | "libre">;
    onChange?: () => void;
    /** The shown language, read when an error is written (default: English). */
    locale?: () => string;
  }) {
    this.locale = o.locale ?? (() => "en");
    this.paths = o.paths;
    this.workshop = o.workshop;
    this.launcher = o.launcher ?? defaultLauncher;
    this.ports = o.ports ?? containerPortRange();
    this.readyDelayMs = o.readyDelayMs ?? READY_DELAY_MS;
    this.probeIntervalMs = o.probeIntervalMs ?? PROBE_INTERVAL_MS;
    this.probe = o.probe ?? probeByDefault;
    this.onChange = o.onChange ?? (() => {});
  }

  /** To be called once per browser life: apps of a previous life are stopped. */
  async start(): Promise<void> {
    // Watching first: the cleanup waits for Docker, sometimes a long time, and the page must follow the projects until then.
    this.watchEnd ??= watchProjects(this.paths, () => this.onChange());
    // Noted right away: a launch requested during this cleanup waits for it.
    this.paced = (async () => {
      if ((await this.workshop.state()) === "demarre") await this.workshop.stopOrphanApps();
    })();
    await this.paced;
  }

  async stopWatching(): Promise<void> {
    await this.watchEnd?.();
    this.watchEnd = undefined;
  }

  /** In-memory state of an app, without reading the disk. */
  stateOf(folder: string): AppState {
    return this.tracked.get(folder)?.state ?? "stopped";
  }

  async list(): Promise<Application[]> {
    return (await readProjects(this.paths)).map((p) => this.view(p));
  }

  private view(p: ProjectRead): Application {
    const s = this.tracked.get(p.folder);
    return {
      folder: p.folder,
      name: p.name,
      createdAt: p.createdAt,
      ...("manifest" in p
        ? { type: p.manifest.type, ...(p.manifest.origin ? { origin: p.manifest.origin } : {}) }
        : { type: "no-manifest" as const, noManifest: p.noManifest }),
      state: s?.state ?? "stopped",
      ...(s?.port !== undefined ? { port: s.port } : {}),
      ...(s?.error !== undefined ? { error: s.error } : {}),
    };
  }

  private change(folder: string, s: Tracking): void {
    this.tracked.set(folder, s);
    this.onChange();
  }

  /** Resolves to « en-marche », « erreur », or « arretee » if the app is stopped in the meantime. Restarts a running app. */
  launch(folder: string): Promise<Application> {
    const token = this.stops.get(folder) ?? 0;
    const next = (this.files.get(folder) ?? Promise.resolve()).catch(() => {}).then(() => this.launchNow(folder, token));
    this.files.set(folder, next);
    return next;
  }

  private async launchNow(folder: string, token: number): Promise<Application> {
    const project = (await readProjects(this.paths)).find((p) => p.folder === folder);
    if (!project) throw new Error(`Projet inconnu : ${folder}`);
    if (!("manifest" in project)) throw new Error(`Projet sans fiche, impossible à lancer (${project.noManifest}) : ${folder}`);
    // Restart: internal stop of the current instance, which does not count as a requested stop.
    if (this.tracked.get(folder)?.launch) await this.stopLaunch(folder);
    if ((this.stops.get(folder) ?? 0) !== token) {
      if (this.stateOf(folder) !== "stopped") this.change(folder, { state: "stopped" });
      return this.view(project);
    }

    const l: Launch = { stop: false };
    /** Final state of the launch, unless the stop was requested in the meantime (the app is then « arretee »). */
    const end = (s: Tracking) => {
      if (!l.stop) this.change(folder, s);
      return this.view(project);
    };
    this.tracked.set(folder, { ...this.tracked.get(folder), state: this.stateOf(folder), launch: l });

    try {
      let state = await this.workshop.state();
      if (l.stop) return this.view(project);
      if (state !== "docker-absent" && state !== "demarre") {
        this.change(folder, { state: "preparing", launch: l });
        state = await this.workshop.ensureStarted();
        if (l.stop) return this.view(project);
      }
      if (state === "docker-absent") return end({ state: "error", error: say(this.locale(), "kernel-app-docker-not-running") });
    } catch (e) {
      return end({ state: "error", error: (e as Error).message });
    }

    await Promise.all([this.paced, this.stopsRunning.get(folder)].map((p) => p?.catch(() => {})));
    if (l.stop) return this.view(project);
    const port = await this.choosePort();
    if (l.stop) return this.view(project);
    if (port === null) return end({ state: "error", error: say(this.locale(), "kernel-app-no-port") });
    this.change(folder, { state: "launching", port, launch: l });

    const outcome = new Promise<Outcome>((r) => (l.wake = r));
    l.process = this.launcher(this.workshop.appCommand(folder, project.manifest.launch, port));
    l.process.onEnd((code) => {
      if (l.stop) return;
      if (l.wake) l.wake({ type: "end", code });
      else void this.unexpectedEnd(folder, l, code);
    });

    const delay = setTimeout(() => l.wake?.({ type: "timeout" }), this.readyDelayMs);
    let probe: NodeJS.Timeout | undefined;
    const probeLater = () => {
      probe = setTimeout(async () => {
        if ((await this.probe(port)) === "http") l.wake?.({ type: "ready" });
        else if (l.wake) probeLater();
      }, this.probeIntervalMs);
    };
    probeLater();
    const i = await outcome;
    l.wake = undefined;
    clearTimeout(delay);
    clearTimeout(probe);

    switch (i.type) {
      case "stop":
        return this.view(project);
      case "ready":
        return end({ state: "running", port, launch: l });
      case "end":
        await this.unexpectedEnd(folder, l, i.code);
        return this.view(project);
      case "timeout": {
        const error = await this.withLog(folder, say(this.locale(), "kernel-app-not-responding", { port: String(port), seconds: Math.round(this.readyDelayMs / 1000) }));
        if (l.stop) return this.view(project);
        // Stop requested before killing: the end of the process does not replace this message.
        l.stop = true;
        this.change(folder, { state: "error", error: error });
        await this.workshop.stopApp(folder);
        l.process.kill();
        return this.view(project);
      }
    }
  }

  /** The process ended without a stop request: during launch or running, it is an error. */
  private async unexpectedEnd(folder: string, l: Launch, code: number | null): Promise<void> {
    const error = await this.withLog(folder, say(this.locale(), code === null ? "kernel-app-exit-unknown" : "kernel-app-exit-code", { code: String(code) }));
    if (l.stop || this.tracked.get(folder)?.launch !== l) return;
    l.stop = true;
    this.change(folder, { state: "error", error: error });
  }

  private async withLog(folder: string, message: string): Promise<string> {
    const end = await this.log(folder, ERROR_LINES);
    return end ? `${message}\n${end}` : message;
  }

  /** First port of the range neither taken by a tracked app nor busy on the machine. */
  private async choosePort(): Promise<number | null> {
    const taken = (p: number) =>
      [...this.tracked.values()].some((s) => s.port === p && (s.state === "launching" || s.state === "running"));
    for (let p = this.ports[0]; p <= this.ports[1]; p++) {
      if (taken(p)) continue;
      const r = await this.probe(p);
      // Re-checked after the probe: another launch may have taken it in the meantime.
      if (r === "libre" && !taken(p)) return p;
    }
    return null;
  }

  /** Stops the app, and cancels its launches requested but not yet started. */
  async stop(folder: string): Promise<void> {
    this.stops.set(folder, (this.stops.get(folder) ?? 0) + 1);
    await this.stopLaunch(folder);
  }

  private async stopLaunch(folder: string): Promise<void> {
    const l = this.tracked.get(folder)?.launch;
    if (!l) return;
    l.stop = true;
    this.change(folder, { state: "stopped" });
    l.wake?.({ type: "stop" });
    const stop = this.workshop.stopApp(folder);
    this.stopsRunning.set(folder, stop);
    try {
      await stop;
    } finally {
      if (this.stopsRunning.get(folder) === stop) this.stopsRunning.delete(folder);
    }
    l.process?.kill();
  }

  /** Project deleted: its state (an error, a port) must not reappear on a project recreated under that name. */
  forget(folder: string): void {
    const s = this.tracked.get(folder);
    // A launch in progress keeps its state: it is up to the stop to finish it.
    if (!s || s.launch) return;
    this.tracked.delete(folder);
    this.onChange();
  }

  async stopAll(): Promise<void> {
    const folders = new Set([...this.tracked.keys(), ...this.files.keys()]);
    await Promise.all([...folders].map((d) => this.stop(d)));
  }

  /** The last `lignes` lines of the app's log (read on the Mac), empty if it does not exist. */
  async log(folder: string, lines = 50): Promise<string> {
    if (!validFolder(folder)) throw new Error(`dossier d'application invalide : ${folder}`);
    let content: string;
    try {
      content = await readFile(join(this.paths.logs, `${folder}.log`), "utf8");
    } catch {
      return "";
    }
    return content.replace(/\n+$/, "").split("\n").slice(-lines).join("\n");
  }
}
