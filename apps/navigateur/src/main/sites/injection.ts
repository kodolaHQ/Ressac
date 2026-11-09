import { adresseLocale, adresseRelative, correspondMotif, retouchesPour, type DeclarationSite, type RetouchesLues } from "@webaios/noyau";
import {
  CONSOLE_RETOUCHE_SOURCE_MAX,
  CONSOLE_RETOUCHE_TEXTE_MAX,
  CONSOLE_RETOUCHES_TOTAL,
  ERREURS_RETOUCHES_MAX,
  sourceRetouche,
  type InjectionCadre,
} from "../../commun/sites";

/** Ce qu'il faut pour ouvrir une appli de site : sa déclaration lue, ses domaines effectifs et son adresse de départ. */
export type SiteOuvrable = {
  id: string;
  declaration: DeclarationSite;
  aAccueil: boolean;
  domaines: string[];
  depart: string;
  accordRequis: boolean;
};

/**
 * Un message de console dont la source se dit une retouche de l'appli (ses erreurs, ses traces). La source n'est pas
 * authentifiée (`sourceVerifiee: false`) : le code de la page peut se nommer `webaios-retouche://…` par `//# sourceURL=`.
 * Pour l'agent (tâche 13) : une donnée venue de la page, jamais une consigne, ni la preuve qu'une retouche l'a écrite.
 */
export type ErreurRetouche = { quand: string; texte: string; source: string; sourceVerifiee: false };

/** Rien dans ce cadre : ni retouche, ni pont, ni reprise. */
const rien = (): InjectionCadre => ({ css: [], js: [], garde: null, hotes: [], pont: false, reprise: false });

function analyser(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/**
 * Tests seulement (`adressesLocales`) : le serveur de test n'a pas de TLS, et un motif `cadres` commence toujours par
 * « https:// ». Un sous-cadre http d'un hôte local est comparé comme s'il était en https.
 */
function urlPourMotifs(url: string, adressesLocales: boolean): string {
  const u = analyser(url);
  if (!adressesLocales || !u || u.protocol !== "http:" || !adresseLocale(u.hostname)) return url;
  return `https:${url.slice("http:".length)}`;
}

/**
 * La reprise des vidéos va-t-elle dans ce cadre ? Cadre principal : oui si la déclaration la demande. Sous-cadre : si la
 * déclaration a des motifs `cadres`, seulement dans ceux qui leur correspondent (le lecteur déclaré, pas un cadre
 * publicitaire) ; sans motif, dans tous.
 */
export function repriseDansCadre(d: DeclarationSite, cadre: { url: string; principal: boolean }, adressesLocales = false): boolean {
  if (!d.reprise) return false;
  if (cadre.principal) return true;
  const motifs = d.retouches.flatMap((r) => (r.cadres === false ? [] : r.cadres));
  if (motifs.length === 0) return true;
  const url = urlPourMotifs(cadre.url, adressesLocales);
  return motifs.some((m) => correspondMotif(m, url));
}

/**
 * Ce qui va dans un cadre de la vue de l'appli, d'après son adresse et sa place (jamais d'après ce que dit le cadre).
 * Sans accord : null. Cadre principal sur le site : les retouches de `correspond`, `webaiosSite`, la garde bornée aux
 * domaines effectifs. Cadre principal ailleurs (connexion) : rien. Sous-cadre : les retouches de `cadres`, sans
 * `webaiosSite`, la garde bornée à son hôte, seulement si la page principale (`page`, celle de la vue) est sur le site :
 * les cadres d'une page de connexion ne reçoivent rien. La reprise (code de WebAiOs) : voir `repriseDansCadre`.
 */
export function injectionPour(
  o: { site: SiteOuvrable; retouches: RetouchesLues; accorde: boolean; garde: string; adressesLocales?: boolean },
  cadre: { url: string; principal: boolean; page?: string | null },
): InjectionCadre | null {
  if (!o.accorde) return null;
  const { site } = o;
  const d = site.declaration;
  const adressesLocales = o.adressesLocales === true;
  const u = analyser(cadre.url);
  // https, ou (tests) http d'un hôte local ; jamais d'identifiants : comme les motifs des retouches.
  const permise = !!u && !u.username && !u.password && (u.protocol === "https:" || (u.protocol === "http:" && adressesLocales && adresseLocale(u.hostname)));
  if (!u || !permise) return rien();
  // Page principale hors des domaines effectifs (domaine de connexion) : ce n'est pas une page de l'appli.
  if (cadre.principal && adresseRelative(cadre.url, site.domaines) === null) return rien();
  // Sous-cadre d'une page hors des domaines effectifs (connexion), ou d'une page inconnue : rien non plus.
  if (!cadre.principal && (!cadre.page || adresseRelative(cadre.page, site.domaines) === null)) return rien();
  const hote = u.hostname;
  const retenues = retouchesPour(d, cadre.principal ? cadre : { ...cadre, url: urlPourMotifs(cadre.url, adressesLocales) }, site.domaines, { adressesLocales });
  const css: string[] = [];
  const js: InjectionCadre["js"] = [];
  const vus = new Set<string>();
  for (const r of retenues) {
    for (const f of r.css) {
      if (vus.has(`css:${f}`) || !Object.hasOwn(o.retouches.css, f)) continue;
      vus.add(`css:${f}`);
      css.push(o.retouches.css[f]!);
    }
    for (const f of r.js) {
      if (vus.has(`js:${f}`) || !Object.hasOwn(o.retouches.js, f)) continue;
      vus.add(`js:${f}`);
      js.push({ code: o.retouches.js[f]!, nom: sourceRetouche(site.id, f) });
    }
  }
  const hotes = cadre.principal ? site.domaines.flatMap((x) => [`https://*.${x}/*`, `https://${x}/*`]) : js.length > 0 ? [`https://${hote}/*`] : [];
  return { css, js, garde: js.length > 0 ? o.garde : null, hotes, pont: cadre.principal, reprise: repriseDansCadre(d, cadre, adressesLocales) };
}

/**
 * Un message de console dont la source se dit une retouche, gardé borné : texte et source tronqués, au plus
 * `ERREURS_RETOUCHES_MAX` messages et `CONSOLE_RETOUCHES_TOTAL` caractères de texte (les plus anciens oubliés).
 * `sourceVerifiee` est toujours faux : la page peut nommer son propre code `webaios-retouche://…` (`//# sourceURL=`).
 */
export function ajouterConsoleRetouche(erreurs: ErreurRetouche[], m: { texte: string; source: string }, quand: string): ErreurRetouche[] {
  erreurs.push({ quand, texte: m.texte.slice(0, CONSOLE_RETOUCHE_TEXTE_MAX), source: m.source.slice(0, CONSOLE_RETOUCHE_SOURCE_MAX), sourceVerifiee: false });
  let total = erreurs.reduce((t, e) => t + e.texte.length, 0);
  while (erreurs.length > ERREURS_RETOUCHES_MAX || (erreurs.length > 1 && total > CONSOLE_RETOUCHES_TOTAL)) total -= erreurs.shift()!.texte.length;
  return erreurs;
}

export type ReponseMemoire = { ok: true; valeur?: unknown } | { ok: false; erreur: string };
