import { ipcMain, type Session, type WebContents, type WebFrameMain } from "electron";
import { adresseLocale, adresseRelative, retouchesPour, type MemoireSite, type RetouchesLues } from "@webaios/noyau";
import { CANAUX_PRELOAD_SITE as CANAUX } from "../../commun/preload-site";
import {
  CONSOLE_RETOUCHE_SOURCE_MAX,
  CONSOLE_RETOUCHE_TEXTE_MAX,
  CONSOLE_RETOUCHES_TOTAL,
  ERREURS_RETOUCHES_MAX,
  sourceRetouche,
  type InjectionCadre,
} from "../../commun/sites";
import type { ErreurRetouche, SiteOuvrable } from "./fenetres";

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
 * Ce qui va dans un cadre de la vue de l'appli, d'après son adresse et sa place (jamais d'après ce que dit le cadre).
 * Sans accord : null. Cadre principal sur le site : les retouches de `correspond`, `webaiosSite`, la garde bornée aux
 * domaines effectifs. Cadre principal ailleurs (connexion) : rien. Sous-cadre : les retouches de `cadres`, sans
 * `webaiosSite`, la garde bornée à son hôte. La reprise (code de WebAiOs) va dans tous les cadres du site.
 */
export function injectionPour(
  o: { site: SiteOuvrable; retouches: RetouchesLues; accorde: boolean; garde: string; adressesLocales?: boolean },
  cadre: { url: string; principal: boolean },
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
  return { css, js, garde: js.length > 0 ? o.garde : null, hotes, pont: cadre.principal, reprise: d.reprise };
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

/**
 * Le cadre qui a envoyé le message, s'il est encore là (un cadre détruit entre-temps n'a rien). Principal : le cadre
 * principal de la vue elle-même (`mainFrame`), jamais un autre cadre sans parent (racine d'un cadre clôturé).
 */
function cadreDe(e: { sender: WebContents; senderFrame: WebFrameMain | null }): { url: string; principal: boolean } | null {
  let f: WebFrameMain | null;
  try {
    f = e.senderFrame;
    if (!f) return null;
    return { url: f.url, principal: f === e.sender.mainFrame };
  } catch {
    return null;
  }
}

type DemandeMemoire = { op: "retenir"; cle: string; valeur: unknown } | { op: "lire" | "oublier"; cle: string };
export type ReponseMemoire = { ok: true; valeur?: unknown } | { ok: false; erreur: string };

const REFUS_MEMOIRE = "Mémoire de l'appli : seulement depuis la page principale de l'appli";

function demandeMemoire(d: unknown): DemandeMemoire | null {
  if (!d || typeof d !== "object") return null;
  const { op, cle } = d as { op?: unknown; cle?: unknown };
  if (typeof cle !== "string") return null;
  if (op === "retenir") return { op, cle, valeur: (d as { valeur?: unknown }).valeur };
  return op === "lire" || op === "oublier" ? { op, cle } : null;
}

/**
 * Les canaux du preload `site.js`. L'appli est celle de la session de l'expéditeur, et seulement si l'expéditeur est sa
 * vue (`vue(id)`) : la petite fenêtre de connexion, de même session, ne reçoit rien. Le cadre (adresse, principal ou
 * non) est celui d'Electron (`senderFrame`), jamais ce que le cadre dit de lui.
 */
export function brancherInjection(o: {
  siteDeSession(s: Session): string | undefined;
  vue(id: string): WebContents | undefined;
  injection(id: string, cadre: { url: string; principal: boolean }): InjectionCadre | null;
  /** L'accord des retouches couvre-t-il la déclaration ? Sans lui, pas de mémoire, quel que soit l'appelant. */
  accorde(id: string): boolean;
  memoire(id: string): Promise<MemoireSite>;
  adresseRelative(id: string, url: string): string | null;
}): void {
  /** L'appli dont `sender` est la vue, ou undefined. */
  const appliDe = (sender: WebContents): string | undefined => {
    let id: string | undefined;
    try {
      id = o.siteDeSession(sender.session);
    } catch {
      return undefined;
    }
    return id !== undefined && o.vue(id) === sender ? id : undefined;
  };

  ipcMain.on(CANAUX.injection, (e) => {
    let reponse: InjectionCadre | null = null;
    try {
      const id = appliDe(e.sender);
      const cadre = id === undefined ? null : cadreDe(e);
      if (id !== undefined && cadre) reponse = o.injection(id, cadre);
    } catch (err) {
      console.error("[sites] injection impossible :", err);
      reponse = null;
    }
    e.returnValue = reponse;
  });

  ipcMain.handle(CANAUX.memoire, async (e, brute: unknown): Promise<ReponseMemoire> => {
    const id = appliDe(e.sender);
    const cadre = id === undefined ? null : cadreDe(e);
    const d = demandeMemoire(brute);
    if (id === undefined || !cadre?.principal || !d || !o.accorde(id)) return { ok: false, erreur: REFUS_MEMOIRE };
    const adresse = o.adresseRelative(id, cadre.url);
    if (adresse === null) return { ok: false, erreur: REFUS_MEMOIRE };
    const m = await o.memoire(id);
    if (d.op === "retenir") {
      const r = m.retenir(d.cle, d.valeur, adresse);
      return r.ok ? { ok: true } : r;
    }
    if (d.op === "lire") return { ok: true, valeur: m.lire(d.cle) };
    m.oublier(d.cle);
    return { ok: true };
  });
}
