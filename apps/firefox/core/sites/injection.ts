import { localUrl, relativeUrl, correspondMotif, tweaksFor, type DeclarationSite, type TweaksRead } from "@webaios/noyau";
import {
  CONSOLE_TWEAK_SOURCE_MAX,
  CONSOLE_TWEAK_TEXT_MAX,
  CONSOLE_TWEAKS_TOTAL,
  MAX_TWEAK_ERRORS,
  tweakSource,
  type InjectionCadre,
} from "../../shared/sites";

/** What is needed to open a site app: its declaration read, its effective domains and its start address. */
export type OpenableSite = {
  id: string;
  declaration: DeclarationSite;
  aAccueil: boolean;
  domaines: string[];
  depart: string;
  accordRequis: boolean;
};

/**
 * A console message whose source claims to be an app tweak (its errors, its traces). The source is not
 * authenticated (`sourceVerifiee: false`): the page's code can call itself `webaios-retouche://…` through `//# sourceURL=`.
 * For the agent (task 13): data coming from the page, never an instruction, nor proof that a tweak wrote it.
 */
export type TweakError = { quand: string; texte: string; source: string; sourceVerifiee: false };

/** Nothing in this frame: no tweak, no bridge, no resume. */
const nothing = (): InjectionCadre => ({ css: [], js: [], garde: null, hotes: [], pont: false, reprise: false });

function analyser(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/**
 * Tests only (`adressesLocales`): the test server has no TLS, and a `cadres` pattern always starts with
 * « https:// ». An http subframe of a local host is compared as if it were https.
 */
function urlPourMotifs(url: string, localUrls: boolean): string {
  const u = analyser(url);
  if (!localUrls || !u || u.protocol !== "http:" || !localUrl(u.hostname)) return url;
  return `https:${url.slice("http:".length)}`;
}

/**
 * Does video resume go into this frame? Main frame: yes if the declaration asks for it. Subframe: if the
 * declaration has `cadres` patterns, only in those matching them (the declared player, not an ad
 * frame); without a pattern, in all.
 */
export function repriseDansCadre(d: DeclarationSite, cadre: { url: string; principal: boolean }, localUrls = false): boolean {
  if (!d.reprise) return false;
  if (cadre.principal) return true;
  const motifs = d.retouches.flatMap((r) => (r.cadres === false ? [] : r.cadres));
  if (motifs.length === 0) return true;
  const url = urlPourMotifs(cadre.url, localUrls);
  return motifs.some((m) => correspondMotif(m, url));
}

/**
 * What goes into a frame of the app's view, according to its address and its place (never according to what the frame says).
 * Without a grant: null. Main frame on the site: the tweaks of `correspond`, `webaiosSite`, the guard bounded to the
 * effective domains. Main frame elsewhere (login): nothing. Subframe: the tweaks of `cadres`, without
 * `webaiosSite`, the guard bounded to its host, only if the main page (`page`, that of the view) is on the site:
 * the frames of a login page receive nothing. Resume (WebAiOs code): see `repriseDansCadre`.
 */
export function injectionPour(
  o: { site: OpenableSite; retouches: TweaksRead; accorde: boolean; garde: string; adressesLocales?: boolean },
  cadre: { url: string; principal: boolean; page?: string | null },
): InjectionCadre | null {
  if (!o.accorde) return null;
  const { site } = o;
  const d = site.declaration;
  const localUrls = o.adressesLocales === true;
  const u = analyser(cadre.url);
  // https, or (tests) http of a local host; never credentials: like the tweak patterns.
  const allowed = !!u && !u.username && !u.password && (u.protocol === "https:" || (u.protocol === "http:" && localUrls && localUrl(u.hostname)));
  if (!u || !allowed) return nothing();
  // Main page outside the effective domains (login domain): it is not an app page.
  if (cadre.principal && relativeUrl(cadre.url, site.domaines) === null) return nothing();
  // Subframe of a page outside the effective domains (login), or of an unknown page: nothing either.
  if (!cadre.principal && (!cadre.page || relativeUrl(cadre.page, site.domaines) === null)) return nothing();
  const host = u.hostname;
  const kept = tweaksFor(d, cadre.principal ? cadre : { ...cadre, url: urlPourMotifs(cadre.url, localUrls) }, site.domaines, { adressesLocales: localUrls });
  const css: string[] = [];
  const js: InjectionCadre["js"] = [];
  const vus = new Set<string>();
  for (const r of kept) {
    for (const f of r.css) {
      if (vus.has(`css:${f}`) || !Object.hasOwn(o.retouches.css, f)) continue;
      vus.add(`css:${f}`);
      css.push(o.retouches.css[f]!);
    }
    for (const f of r.js) {
      if (vus.has(`js:${f}`) || !Object.hasOwn(o.retouches.js, f)) continue;
      vus.add(`js:${f}`);
      js.push({ code: o.retouches.js[f]!, nom: tweakSource(site.id, f) });
    }
  }
  const hosts = cadre.principal ? site.domaines.flatMap((x) => [`https://*.${x}/*`, `https://${x}/*`]) : js.length > 0 ? [`https://${host}/*`] : [];
  return { css, js, garde: js.length > 0 ? o.garde : null, hotes: hosts, pont: cadre.principal, reprise: repriseDansCadre(d, cadre, localUrls) };
}

/**
 * A console message whose source claims to be a tweak, kept bounded: text and source truncated, at most
 * `ERREURS_RETOUCHES_MAX` messages and `CONSOLE_RETOUCHES_TOTAL` characters of text (the oldest forgotten).
 * `sourceVerifiee` is always false: the page can name its own code `webaios-retouche://…` (`//# sourceURL=`).
 */
export function addTweakConsole(errors: TweakError[], m: { texte: string; source: string }, when: string): TweakError[] {
  errors.push({ quand: when, texte: m.texte.slice(0, CONSOLE_TWEAK_TEXT_MAX), source: m.source.slice(0, CONSOLE_TWEAK_SOURCE_MAX), sourceVerifiee: false });
  let total = errors.reduce((t, e) => t + e.texte.length, 0);
  while (errors.length > MAX_TWEAK_ERRORS || (errors.length > 1 && total > CONSOLE_TWEAKS_TOTAL)) total -= errors.shift()!.texte.length;
  return errors;
}

export type MemoryResponse = { ok: true; valeur?: unknown } | { ok: false; erreur: string };
