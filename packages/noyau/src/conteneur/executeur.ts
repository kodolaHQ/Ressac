import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ResultatExecution {
  code: number;
  stdout: string;
  stderr: string;
}

export type Executeur = (commande: string, args: string[], opts?: { delaiMs?: number }) => Promise<ResultatExecution>;

/** Code renvoyé quand le délai est dépassé (même convention que timeout(1)). */
export const CODE_DELAI_DEPASSE = 124;

/** Dossiers où vivent docker et ses assistants (identifiants) quand l'app est lancée depuis le Finder. */
export const DOSSIERS_OUTILS = ["/usr/local/bin", "/opt/homebrew/bin", join(homedir(), ".orbstack", "bin")];

/** Lance une commande sans jamais lever d'exception : un échec se lit dans `code`. */
export const executeurParDefaut: Executeur = (commande, args, opts = {}) =>
  new Promise((resoudre) => {
    const PATH = [process.env.PATH ?? "", ...DOSSIERS_OUTILS].filter(Boolean).join(":");
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
