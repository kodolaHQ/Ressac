import { execFile, spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ResultatExecution {
  code: number;
  stdout: string;
  stderr: string;
}

/** `signal` : annule la commande (tout son groupe de processus est tué), le résultat a alors le code CODE_ANNULE. */
export type Executeur = (commande: string, args: string[], opts?: { delaiMs?: number; signal?: AbortSignal }) => Promise<ResultatExecution>;

/** Code renvoyé quand le délai est dépassé (même convention que timeout(1)). */
export const CODE_DELAI_DEPASSE = 124;

/** Code renvoyé quand la commande est annulée par son signal (128 + SIGTERM). */
export const CODE_ANNULE = 143;

/** Délai entre SIGTERM et SIGKILL quand un groupe annulé ne s'arrête pas. */
const DELAI_KILL_ANNULE_MS = 2000;

/** Groupes de processus encore vivants : tués de façon synchrone si le process Node sort sans les arrêter. */
const groupesVivants = new Set<number>();
let sortieBranchee = false;

/** Envoie `signal` à tout le groupe `pid` ; faux si le groupe est déjà mort (0 : simple vérification). */
export function tuerGroupe(pid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
}

/** Retient un groupe lancé en `detached` : s'il vit encore quand le process Node sort, il est tué (SIGKILL). */
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

/** Dossiers où vivent docker et ses assistants (identifiants) quand l'app est lancée depuis le Finder. */
export const DOSSIERS_OUTILS = [
  "/usr/local/bin",
  "/opt/homebrew/bin",
  join(homedir(), ".orbstack", "bin"),
  join(homedir(), ".docker", "bin"), // Docker Desktop installé par utilisateur
];

/** PATH enrichi des dossiers d'outils (l'app lancée depuis le Finder a un PATH minimal). */
export const cheminOutils = (): string => [process.env.PATH ?? "", ...DOSSIERS_OUTILS].filter(Boolean).join(":");

/** Lance une commande sans jamais lever d'exception : un échec se lit dans `code`. */
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
 * Variante annulable : la commande vit dans son propre groupe de processus (git lance git-remote-https, uv ses
 * compilations ; execFile ne sait pas en créer un). Annuler, ou dépasser le délai, envoie SIGTERM au groupe, puis
 * SIGKILL après 2 s s'il vit encore ; si Node sort avant, le groupe est tué à la sortie.
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
