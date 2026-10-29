// Harnais du moteur des workflows : lance recolteur.mjs dans un processus Node et répond à ses appels.
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dossierTemporaire } from "./temporaire.js";
import { validerWorkflow } from "../../src/workflows/valider.js";
import type { MemoireBlocs } from "../../src/workflows/memoire.js";

export const MOTEUR = join(import.meta.dirname, "..", "..", "docker", "moteur");
export const SCRIPT = join(MOTEUR, "recolteur.mjs");

export type Appel = { t: "appel"; n: number; f: string; a: any };
export type Repondeur = (appel: Appel) => Promise<{ ok: unknown } | { erreur: string }> | { ok: unknown } | { erreur: string };

/** Le workflow tel que le noyau l'envoie : validé, paramètres par défaut remplis, avec l'ordre. */
export function workflowEnvoye(brut: unknown) {
  const r = validerWorkflow(brut);
  if (!r.ok) throw new Error(r.erreur);
  return { blocs: r.valide.workflow.blocs, liens: r.valide.workflow.liens, ordre: r.valide.ordre };
}

export async function lancer(o: {
  workflow: unknown;
  fichiers?: Record<string, string>;
  memoire?: MemoireBlocs;
  config?: unknown;
  precedent?: unknown;
  repondre?: Repondeur;
}) {
  const dossier = await dossierTemporaire();
  await writeFile(join(dossier, "widget.json"), JSON.stringify({ config: { lu: "dans widget.json" } }));
  for (const [nom, contenu] of Object.entries(o.fichiers ?? {})) await writeFile(join(dossier, nom), contenu);
  const enfant = spawn("node", [SCRIPT, dossier], { stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  enfant.stderr.on("data", (d) => (stderr += d));
  const lignes: any[] = [];
  const appels: Appel[] = [];
  let tampon = "";
  const fini = new Promise<number | null>((ok) => enfant.on("close", (code) => ok(code)));
  enfant.stdout.on("data", (d) => {
    tampon += d;
    let i;
    while ((i = tampon.indexOf("\n")) >= 0) {
      const ligne = tampon.slice(0, i);
      tampon = tampon.slice(i + 1);
      const m = JSON.parse(ligne);
      lignes.push(m);
      if (m.t === "appel") {
        appels.push(m);
        const repondre = o.repondre ?? (() => ({ ok: null }));
        void Promise.resolve(repondre(m)).then((r) => enfant.stdin.write(JSON.stringify({ t: "reponse", n: m.n, ...r }) + "\n"));
      }
    }
  });
  enfant.stdin.write(
    JSON.stringify({
      t: "debut",
      precedent: o.precedent ?? null,
      maintenant: "2026-10-29T10:00:00.000Z",
      config: o.config ?? null,
      workflow: workflowEnvoye(o.workflow),
    }) + "\n",
  );
  enfant.stdin.write(JSON.stringify({ t: "memoire", memoire: o.memoire ?? {} }) + "\n");
  const code = await fini;
  return {
    code,
    lignes,
    appels,
    stderr,
    traces: lignes.filter((l) => l.t !== "appel"),
    terminal: lignes.find((l) => l.t === "fin" || l.t === "echec"),
    finBloc: (id: string) => lignes.find((l) => l.t === "bloc" && l.id === id && l.etape === "fin"),
  };
}

export const bloc = (id: string, type: string, parametres: Record<string, unknown> = {}) => ({ id, type, parametres });
export const chaine = (...ids: string[]) => ids.slice(1).map((vers, i) => ({ de: ids[i]!, vers }));
export const sortie = bloc("sortie", "sortie", { vers: "widget" });
