import { REGISTRE_BLOCS } from "./blocs/index.js";
import { chaineAuFilDeLEau } from "./chaine.js";
import type { Workflow } from "./schema.js";
import type { WorkflowValide } from "./valider.js";

export const AVERTISSEMENT_FIL_DE_L_EAU = "rien à publier au fil de l'eau : l'entrée de la sortie n'est pas traitée élément par élément";

/** A web search quickly takes more than the 150 s of an ordinary run. */
export const AVERTISSEMENT_WEB_SANS_DUREE = "sans dureeMaxMinutes, ce widget peut être coupé à 150 s : demande à l'agent de déclarer dureeMaxMinutes";

export const AVERTISSEMENT_SAISIE = "{saisie} : l'action ne déclare pas de saisie";

export type Avertissement = { bloc: string; message: string };

/** The host of an address, unless the part before the path contains a template (`{…}`) or is not http(s). */
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
 * What does not block saving but risks making the run fail: a domain absent from the declared
 * sources (only for a widget with an account), a `{config.…}` key absent from the widget's config and, with
 * `valide` (the same validated workflow), an "as-it-goes" output without a chain: it would have nothing to publish. With
 * `dureeMaxMinutes: null` (the widget declares none), each `web.chercher`: the run risks being cut off.
 */
export function avertirWorkflow(
  workflow: Workflow,
  ctx: { sources: { compte: readonly string[]; publiques: readonly string[] }; config: unknown;
    dureeMaxMinutes?: number | null;
    /** An action without `saisie` receives nothing in `{saisie}`. */
    proprietaire?: "widget" | "action";
    saisie?: boolean;
  },
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
      // An optional marker (`{config.x?}`) does not need the value: it is never reported.
      for (const m of v.matchAll(/\{config\.([A-Za-z0-9_]+)[^}]*\}/g)) {
        if (!m[0].endsWith("?}") && !Object.hasOwn(config, m[1]!)) manquantes.add(m[1]!);
      }
    }
    if (ctx.proprietaire === "action" && ctx.saisie !== true) {
      const aSaisie = champs.some((c) => {
        const v = b.parametres[c.nom];
        return typeof v === "string" && /\{saisie\??\}/.test(v);
      });
      if (aSaisie) r.push({ bloc: b.id, message: AVERTISSEMENT_SAISIE });
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
