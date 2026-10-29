import { REGISTRE_BLOCS } from "./blocs/index.js";
import { chaineAuFilDeLEau } from "./chaine.js";
import type { Workflow } from "./schema.js";
import type { WorkflowValide } from "./valider.js";

export const AVERTISSEMENT_FIL_DE_L_EAU = "rien à publier au fil de l'eau : l'entrée de la sortie n'est pas traitée élément par élément";

/** Une recherche web prend vite plus que les 150 s d'une exécution ordinaire. */
export const AVERTISSEMENT_WEB_SANS_DUREE = "sans dureeMaxMinutes, ce widget peut être coupé à 150 s : demande à l'agent de déclarer dureeMaxMinutes";

export type Avertissement = { bloc: string; message: string };

/** L'hôte d'une adresse, sauf si la partie avant le chemin contient un gabarit (`{…}`) ou n'est pas http(s). */
function hoteDe(url: string): string | null {
  const m = /^https?:\/\/([^/?#]*)/i.exec(url.trim());
  if (!m || m[1]!.includes("{")) return null;
  try {
    return new URL(url.trim()).hostname.toLowerCase().replace(/\.+$/, "") || null;
  } catch {
    return null;
  }
}

/**
 * Ce qui ne bloque pas l'enregistrement mais risque de faire échouer l'exécution : un domaine absent des sources
 * déclarées (seulement pour un widget avec compte), une clé `{config.…}` absente de la configuration du widget et, avec
 * `valide` (le même workflow validé), une sortie « au fil de l'eau » sans chaîne : elle n'aurait rien à publier. Avec
 * `dureeMaxMinutes: null` (le widget n'en déclare pas), chaque `web.chercher` : l'exécution risque d'être coupée.
 */
export function avertirWorkflow(
  workflow: Workflow,
  ctx: { sources: { compte: readonly string[]; publiques: readonly string[] }; config: unknown; dureeMaxMinutes?: number | null },
  valide?: WorkflowValide,
): Avertissement[] {
  const r: Avertissement[] = [];
  const aCompte = ctx.sources.compte.length > 0;
  const config = ctx.config !== null && typeof ctx.config === "object" ? (ctx.config as Record<string, unknown>) : {};
  for (const b of workflow.blocs) {
    if (aCompte) {
      let urls: string[] = [];
      let permis: readonly string[] = ctx.sources.publiques;
      const p = b.parametres;
      if (b.type === "source.page" && typeof p.url === "string") {
        urls = [p.url];
        if (p.compte === true) permis = ctx.sources.compte;
      } else if (b.type === "source.recuperer" && typeof p.url === "string") urls = [p.url];
      else if (b.type === "source.flux" && Array.isArray(p.urls)) urls = p.urls.filter((u): u is string => typeof u === "string");
      for (const u of urls) {
        const hote = hoteDe(u);
        if (hote && !permis.includes(hote)) r.push({ bloc: b.id, message: `domaine non déclaré : ${hote}` });
      }
    }
    const champs = REGISTRE_BLOCS.get(b.type)?.champs.filter((c) => c.genre === "gabarit") ?? [];
    const manquantes = new Set<string>();
    for (const c of champs) {
      const v = b.parametres[c.nom];
      if (typeof v !== "string") continue;
      for (const m of v.matchAll(/\{config\.([A-Za-z0-9_]+)[^}]*\}/g)) {
        if (!Object.hasOwn(config, m[1]!)) manquantes.add(m[1]!);
      }
    }
    for (const cle of manquantes) r.push({ bloc: b.id, message: `config.${cle} absent de la configuration du widget` });
    if (b.type === "web.chercher" && ctx.dureeMaxMinutes === null) r.push({ bloc: b.id, message: AVERTISSEMENT_WEB_SANS_DUREE });
  }
  if (valide) {
    const sortie = valide.workflow.blocs.find((b) => b.id === valide.sortie.id);
    if (sortie?.parametres.auFilDeLEau === true && chaineAuFilDeLEau(valide).length === 0) {
      r.push({ bloc: valide.sortie.id, message: AVERTISSEMENT_FIL_DE_L_EAU });
    }
  }
  return r;
}
