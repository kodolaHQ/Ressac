import { execFile, spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ResultatExecution {
  code: number;
  stdout: string;
  stderr: string;
}

/** `signal`: cancels the command (its whole process group is killed), the result then has the code CODE_ANNULE. */
export type Executeur = (commande: string, args: string[], opts?: { delaiMs?: number; signal?: AbortSignal }) => Promise<ResultatExecution>;

/** Code returned when the timeout is exceeded (same convention as timeout(1)). */
export const CODE_DELAI_DEPASSE = 124;

/** Code returned when the command is cancelled by its signal (128 + SIGTERM). */
export const CODE_ANNULE = 143;

/** Delay between SIGTERM and SIGKILL when a cancelled group does not stop. */
const DELAI_KILL_ANNULE_MS = 2000;

/** Process groups still alive: killed synchronously if the Node process exits without stopping them. */
const groupesVivants = new Set<number>();
let sortieBranchee = false;

/** Sends `signal` to the whole group `pid`; false if the group is already dead (0: simple check). */
export function tuerGroupe(pid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
}

/** Remembers a group launched `detached`: if it is still alive when the Node process exits, it is killed (SIGKILL). */
export function retenirGroupe(pid: number): void {
  groupesVivants.add(pid);
  if (sortieBranchee) return;
  sortieBranchee = true;
  process.on("exit", () => {
    for (const g of groupesVivants) tuerGroupe(g, "SIGKILL");
  });
}

export function oublierGroupe(pid: number): void {
  groupesVivants.delete(pid);
}

/** Folders where docker and its helpers (credentials) live when the app is launched from the Finder. */
export const DOSSIERS_OUTILS = [
  "/usr/local/bin",
  "/opt/homebrew/bin",
  join(homedir(), ".orbstack", "bin"),
  join(homedir(), ".docker", "bin"), // Docker Desktop installed per user
];

/** PATH enriched with tool folders (the app launched from the Finder has a minimal PATH). */
export const cheminOutils = (): string => [process.env.PATH ?? "", ...DOSSIERS_OUTILS].filter(Boolean).join(":");

/** Launches a command without ever throwing: a failure reads in `code`. */
export const executeurParDefaut: Executeur = (commande, args, opts = {}) => {
  if (opts.signal) return executerAnnulable(commande, args, opts.signal, opts.delaiMs);
  return new Promise((resoudre) => {
    const PATH = cheminOutils();
    execFile(
      commande,
      args,
      { timeout: opts.delaiMs, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, PATH } },
      (erreur, stdout, stderr) => {
        if (!erreur) return resoudre({ code: 0, stdout, stderr });
        const e = erreur as NodeJS.ErrnoException & { killed?: boolean; code?: number | string };
        if (e.code === "ENOENT") return resoudre({ code: 127, stdout, stderr: `${commande} introuvable` });
        if (e.killed && opts.delaiMs) return resoudre({ code: CODE_DELAI_DEPASSE, stdout, stderr: "Délai dépassé" });
        resoudre({ code: typeof e.code === "number" ? e.code : 1, stdout, stderr });
      },
    );
  });
};

/**
 * Cancellable variant: the command lives in its own process group (git launches git-remote-https, uv its
 * compilations; execFile cannot create one). Cancelling, or exceeding the timeout, sends SIGTERM to the group, then
 * SIGKILL after 2 s if it is still alive; if Node exits before, the group is killed at exit.
 */
function executerAnnulable(commande: string, args: string[], signal: AbortSignal, delaiMs?: number): Promise<ResultatExecution> {
  return new Promise((resoudre) => {
    if (signal.aborted) return resoudre({ code: CODE_ANNULE, stdout: "", stderr: "Annulé" });
    const enfant = spawn(commande, args, { env: { ...process.env, PATH: cheminOutils() }, stdio: ["ignore", "pipe", "pipe"], detached: true });
    const pid = enfant.pid;
    if (pid !== undefined) retenirGroupe(pid);
    const sorties = { stdout: "", stderr: "" };
    const garder = (cle: "stdout" | "stderr") => (d: Buffer) => {
      if (sorties[cle].length < 64 * 1024 * 1024) sorties[cle] += d.toString("utf8");
    };
    enfant.stdout?.on("data", garder("stdout"));
    enfant.stderr?.on("data", garder("stderr"));
    let delaiDepasse = false;
    const tuer = () => {
      if (pid === undefined || !tuerGroupe(pid, "SIGTERM")) return;
      const minuterie = setTimeout(() => {
        tuerGroupe(pid, "SIGKILL");
        oublierGroupe(pid);
      }, DELAI_KILL_ANNULE_MS);
      minuterie.unref();
    };
    const annuler = () => tuer();
    signal.addEventListener("abort", annuler, { once: true });
    const minuterieDelai = delaiMs
      ? setTimeout(() => {
          delaiDepasse = true;
          tuer();
        }, delaiMs)
      : undefined;
    let fini = false;
    const finir = (r: ResultatExecution) => {
      if (fini) return;
      fini = true;
      signal.removeEventListener("abort", annuler);
      clearTimeout(minuterieDelai);
      if (pid !== undefined && !tuerGroupe(pid, 0)) oublierGroupe(pid);
      resoudre(r);
    };
    enfant.on("error", (e: NodeJS.ErrnoException) =>
      finir(e.code === "ENOENT" ? { code: 127, ...sorties, stderr: `${commande} introuvable` } : { code: 1, ...sorties, stderr: e.message }),
    );
    enfant.on("close", (code) => {
      if (signal.aborted) return finir({ code: CODE_ANNULE, ...sorties, stderr: sorties.stderr || "Annulé" });
      if (delaiDepasse) return finir({ code: CODE_DELAI_DEPASSE, ...sorties, stderr: "Délai dépassé" });
      finir({ code: code ?? 1, ...sorties });
    });
  });
}
