import type { Rectangle, WebContents, WebFrameMain } from "electron";
import { HTML_MAX, MARGE_CAPTURE, MONDE_VISEUR, STYLES_UTILES, TRONQUE, tronquerHtml, type ContexteDesign } from "@webaios/noyau";
import { CANAUX } from "../../commun/canaux";

export interface CaptureViseur extends Omit<ContexteDesign, "source"> {
  rect: { x: number; y: number; largeur: number; hauteur: number };
}
type RectCss = CaptureViseur["rect"];

/**
 * Code du monde isolé : pose le viseur, résout avec la capture du clic (ou null : Échap, arrêt). L'arrêt est exposé
 * dans une variable du monde isolé (`__viseurArret`), invisible de la page. La page ne voit aucun événement de souris.
 */
export function scriptViseur(): string {
  return `(() => {
  if (typeof globalThis.__viseurArret === "function") globalThis.__viseurArret();
  // Un nouvel armement retire l'avalement des clics laissé par la capture précédente : il a ses propres écouteurs.
  if (typeof globalThis.__viseurAvaler === "function") globalThis.__viseurAvaler();
  const STYLES = ${JSON.stringify(STYLES_UTILES)};
  const HTML_MAX = ${HTML_MAX};
  const TRONQUE = ${JSON.stringify(TRONQUE)};
  return new Promise((resolve) => {
    const hote = document.createElement("webaios-viseur");
    const ombre = hote.attachShadow({ mode: "closed" });
    const base = "position:fixed;pointer-events:none;z-index:2147483647;";
    const cadre = document.createElement("div");
    cadre.style.cssText = base + "box-sizing:border-box;border:2px solid #6d5efc;background:rgba(109,94,252,.15);display:none;";
    const etiquette = document.createElement("div");
    etiquette.style.cssText = base + "font:11px/1.3 monospace;color:#fff;background:#6d5efc;padding:1px 5px;border-radius:3px;display:none;white-space:nowrap;";
    ombre.append(cadre, etiquette);
    document.documentElement.appendChild(hote);

    const nom = (el) => {
      let t = el.localName;
      if (el.id) t += "#" + el.id;
      const c = el.classList && el.classList[0];
      if (c) t += "." + c;
      return t;
    };
    const unique = (sel, el) => { try { const l = document.querySelectorAll(sel); return l.length === 1 && l[0] === el; } catch { return false; } };
    const chemin = (el, complet) => {
      const morceaux = [];
      let n = el;
      while (n && n.nodeType === 1) {
        if (!complet && n !== el && n.id && unique("#" + CSS.escape(n.id), n)) { morceaux.unshift("#" + CSS.escape(n.id)); break; }
        if (n === document.documentElement) { morceaux.unshift("html"); break; }
        let rang = 1;
        for (let f = n.previousElementSibling; f; f = f.previousElementSibling) if (f.localName === n.localName) rang++;
        morceaux.unshift(CSS.escape(n.localName) + ":nth-of-type(" + rang + ")");
        n = n.parentElement;
      }
      return morceaux.join(" > ");
    };
    const selecteurDe = (el) => {
      if (el.id) { const s = "#" + CSS.escape(el.id); if (unique(s, el)) return s; }
      const court = chemin(el, false);
      return unique(court, el) ? court : chemin(el, true);
    };
    const placer = (el) => {
      if (!el || el === hote) return;
      const r = el.getBoundingClientRect();
      cadre.style.display = etiquette.style.display = "block";
      cadre.style.left = r.left + "px"; cadre.style.top = r.top + "px";
      cadre.style.width = r.width + "px"; cadre.style.height = r.height + "px";
      etiquette.textContent = nom(el);
      etiquette.style.left = Math.max(0, r.left) + "px";
      etiquette.style.top = (r.top > 20 ? r.top - 20 : r.bottom + 2) + "px";
    };

    const bloque = (e) => { e.preventDefault(); e.stopImmediatePropagation(); };
    // Les événements fabriqués par la page (isTrusted faux) passent sans être touchés : seuls ceux de l'utilisateur comptent.
    const surSouris = (e) => { if (e.isTrusted) bloque(e); };
    // Pendant la visée, « click » est traité à part (surClic) ; l'avaler seul après la capture.
    const TYPES_VISEE = ["pointerdown", "pointerup", "mousedown", "mouseup", "auxclick", "contextmenu", "dblclick"];
    const TYPES_SOURIS = ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "auxclick", "contextmenu", "dblclick"];
    const surMove = (e) => { if (e.target instanceof Element) placer(e.target); };
    const fin = (valeur) => {
      for (const t of TYPES_SOURIS) window.removeEventListener(t, surSouris, true);
      window.removeEventListener("click", surClic, true);
      if (valeur) {
        // La fin d'un double clic (deuxième clic, dblclick) ne doit pas atteindre la page.
        for (const t of TYPES_SOURIS) window.addEventListener(t, surSouris, true);
        const avaler = () => {
          clearTimeout(minuterie);
          for (const t of TYPES_SOURIS) window.removeEventListener(t, surSouris, true);
          if (globalThis.__viseurAvaler === avaler) delete globalThis.__viseurAvaler;
        };
        const minuterie = setTimeout(avaler, 500);
        globalThis.__viseurAvaler = avaler;
      }
      window.removeEventListener("mousemove", surMove, true);
      window.removeEventListener("keydown", surTouche, true);
      hote.remove();
      if (globalThis.__viseurArret === arret) delete globalThis.__viseurArret;
      resolve(valeur);
    };
    const arret = () => fin(null);
    const surTouche = (e) => { if (e.isTrusted && e.key === "Escape") { bloque(e); fin(null); } };
    const surClic = (e) => {
      if (!e.isTrusted) return;
      bloque(e);
      const el = e.target;
      if (!(el instanceof Element)) return fin(null);
      const r = el.getBoundingClientRect();
      const html = el.outerHTML;
      const parent = el.parentElement;
      const freres = parent ? [...parent.children].filter((f) => f !== el).slice(0, 10)
        .map((f) => f.localName + " : " + (f.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 40)) : [];
      const cs = getComputedStyle(el);
      const styles = {};
      for (const p of STYLES) styles[p] = cs.getPropertyValue(p);
      fin({
        selecteur: selecteurDe(el), etiquette: nom(el),
        html: html.length > HTML_MAX ? html.slice(0, HTML_MAX) + TRONQUE : html,
        voisinage: { parent: parent ? nom(parent) : "", freres },
        styles, rect: { x: r.x, y: r.y, largeur: r.width, hauteur: r.height },
        adresse: location.href, vue: { largeur: innerWidth, hauteur: innerHeight },
      });
    };
    for (const t of TYPES_VISEE) window.addEventListener(t, surSouris, true);
    window.addEventListener("click", surClic, true);
    window.addEventListener("mousemove", surMove, true);
    window.addEventListener("keydown", surTouche, true);
    globalThis.__viseurArret = arret;
  });
})()`;
}

const ARRET = `typeof globalThis.__viseurArret === "function" && globalThis.__viseurArret(); typeof globalThis.__viseurAvaler === "function" && globalThis.__viseurAvaler()`;

const fini = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const chaine = (c: unknown, max = 1_000_000): c is string => typeof c === "string" && c.length <= max;

/** Le monde isolé est sûr, mais la forme est vérifiée quand même : null si elle n'est pas celle attendue. */
function propreCapture(v: unknown): CaptureViseur | null {
  const c = v as Partial<CaptureViseur> | null;
  if (!c || typeof c !== "object" || !c.rect || !c.vue || !c.voisinage || !c.styles) return null;
  if (![c.rect.x, c.rect.y, c.rect.largeur, c.rect.hauteur, c.vue.largeur, c.vue.hauteur].every(fini)) return null;
  if (![c.selecteur, c.etiquette, c.html, c.adresse, c.voisinage.parent].every((x) => chaine(x))) return null;
  if (!Array.isArray(c.voisinage.freres) || !c.voisinage.freres.every((f) => chaine(f))) return null;
  if (!Object.values(c.styles).every((x) => chaine(x))) return null;
  return c as CaptureViseur;
}

/**
 * Le cadre de l'accueil d'une appli de site. Le monde isolé d'un cadre n'est pas joignable d'ici : le code y passe par
 * le preload du cadre (canal `designViseurCadre`), qui le lance dans `MONDE_VISEUR` et renvoie le résultat
 * (`designViseurResultat`, reçu par `resultatViseurCadre`).
 */
export type CadreViseur = Pick<WebFrameMain, "send" | "executeJavaScript" | "isDestroyed" | "frameTreeNodeId">;

let jetonCadre = 0;
/** Les codes lancés dans un cadre, en attente de leur résultat, par jeton. */
const attentesCadre = new Map<number, { cadre: number; ok: (r: unknown) => void }>();

function executerDansCadre(cadre: CadreViseur, code: string): Promise<unknown> {
  if (cadre.isDestroyed()) return Promise.resolve(null);
  const jeton = ++jetonCadre;
  return new Promise((ok) => {
    attentesCadre.set(jeton, { cadre: cadre.frameTreeNodeId, ok });
    try {
      cadre.send(CANAUX.designViseurCadre, { jeton, monde: MONDE_VISEUR, code });
    } catch {
      attentesCadre.delete(jeton);
      ok(null);
    }
  });
}

/** Le résultat renvoyé par le preload d'un cadre : retenu seulement s'il vient du cadre où le code a été lancé. */
export function resultatViseurCadre(expediteur: { frameTreeNodeId: number } | null, jeton: unknown, r: unknown): void {
  if (typeof jeton !== "number") return;
  const a = attentesCadre.get(jeton);
  if (!a || !expediteur || expediteur.frameTreeNodeId !== a.cadre) return;
  attentesCadre.delete(jeton);
  a.ok(r);
}

/** Le cadre est parti (vue changée, fenêtre fermée) : ses attentes se résolvent à null. */
function abandonnerCadre(cadre: CadreViseur): void {
  for (const [jeton, a] of attentesCadre) if (a.cadre === cadre.frameTreeNodeId) {
    attentesCadre.delete(jeton);
    a.ok(null);
  }
}

const dansLeMonde = (wc: WebContents, cadre: CadreViseur | null, code: string): Promise<unknown> =>
  cadre ? executerDansCadre(cadre, code) : wc.executeJavaScriptInIsolatedWorld(MONDE_VISEUR, [{ code }]);

const armes = new Map<WebContents, () => void>();

/**
 * Arme le viseur dans la page de `wc`, ou dans son cadre `cadre` (l'accueil d'une appli de site) ; null : Échap,
 * désarmement, navigation (de la page ou du cadre) ou page détruite.
 */
export async function armerViseur(wc: WebContents, cadre: CadreViseur | null = null): Promise<CaptureViseur | null> {
  armes.get(wc)?.();
  return new Promise<CaptureViseur | null>((resolve) => {
    let fini = false;
    const surNavigationDetails = (details: { isMainFrame: boolean; frame?: { frameTreeNodeId: number } | null }) => {
      if (cadre ? details.frame?.frameTreeNodeId === cadre.frameTreeNodeId : details.isMainFrame) clore(null);
    };
    const clore = (v: CaptureViseur | null) => {
      if (fini) return;
      fini = true;
      if (armes.get(wc) === annuler) armes.delete(wc);
      if (!wc.isDestroyed()) {
        wc.off("did-start-navigation", surNavigationDetails);
        wc.off("render-process-gone", surMort);
        wc.off("destroyed", surMort);
      }
      // Navigation sans changement de document, ou qui n'aboutit pas : le script tourne encore, on l'arrête.
      if (!v && !wc.isDestroyed()) void dansLeMonde(wc, cadre, ARRET).catch(() => {});
      if (!v && cadre) abandonnerCadre(cadre);
      const propre = v ? propreCapture(v) : null;
      resolve(propre ? { ...propre, html: tronquerHtml(propre.html) } : null);
    };
    const surMort = () => clore(null);
    const annuler = () => clore(null);
    armes.set(wc, annuler);
    wc.on("did-start-navigation", surNavigationDetails);
    wc.on("render-process-gone", surMort);
    wc.on("destroyed", surMort);
    if (wc.isDestroyed()) return clore(null);
    dansLeMonde(wc, cadre, scriptViseur()).then(
      (r) => clore((r as CaptureViseur | null) ?? null),
      () => clore(null),
    );
  });
}

export async function desarmerViseur(wc: WebContents, cadre: CadreViseur | null = null): Promise<void> {
  if (wc.isDestroyed()) return;
  try {
    await dansLeMonde(wc, cadre, ARRET);
  } catch {
    // page déjà partie : rien à retirer
  }
  armes.get(wc)?.();
}

const entierPositif = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n > 0;

/** Ce qui vient du monde de la page n'est jamais cru : fichier court, numéros entiers positifs, le reste est écarté. */
function sourceSaine(r: unknown): ContexteDesign["source"] {
  const o = r as { fichier?: unknown; ligne?: unknown; colonne?: unknown } | null;
  if (!o || typeof o !== "object" || !chaine(o.fichier, 1024) || o.fichier === "") return null;
  return { fichier: o.fichier, ...(entierPositif(o.ligne) ? { ligne: o.ligne } : {}), ...(entierPositif(o.colonne) ? { colonne: o.colonne } : {}) };
}

/**
 * Source de l'élément, lue dans le monde de la page (ou du cadre `cadre`) par une expression sans effet ni global ; null
 * si inconnue.
 */
export async function lireSource(wc: WebContents, selecteur: string, cadre: CadreViseur | null = null): Promise<ContexteDesign["source"]> {
  const code = `(() => {
    try {
      const el = document.querySelector(${JSON.stringify(selecteur)});
      if (!el) return null;
      const ds = el.getAttribute("data-source");
      if (ds) { const m = /^(.*?):(\\d+)(?::(\\d+))?$/.exec(ds); return m ? { fichier: m[1], ligne: Number(m[2]), ...(m[3] ? { colonne: Number(m[3]) } : {}) } : { fichier: ds }; }
      const ch = el.getAttribute("data-inspector-relative-path"), li = el.getAttribute("data-inspector-line");
      if (ch && li) return { fichier: ch, ligne: Number(li) };
      const loc = el.__svelte_meta && el.__svelte_meta.loc;
      if (loc && loc.file) return { fichier: loc.file, ligne: loc.line, colonne: loc.column };
      const vue = el.__vueParentComponent && el.__vueParentComponent.type && el.__vueParentComponent.type.__file;
      if (vue) return { fichier: vue };
      const cle = Object.keys(el).find((k) => k.startsWith("__reactFiber$"));
      if (cle) {
        let f = el[cle];
        for (let i = 0; f && i < 50; i++, f = f.return)
          if (f._debugSource && f._debugSource.fileName) return { fichier: f._debugSource.fileName, ligne: f._debugSource.lineNumber };
      }
      return null;
    } catch { return null; }
  })()`;
  try {
    const r = await Promise.race([
      (cadre ? cadre.executeJavaScript(code) : wc.executeJavaScript(code)) as Promise<unknown>,
      new Promise<null>((ok) => setTimeout(() => ok(null), 1500)),
    ]);
    return sourceSaine(r);
  } catch {
    return null;
  }
}

/**
 * Rect CSS de l'élément élargi de la marge, en pixels de la vue (× zoom), borné à la vue et arrondi, puis décalé de
 * `decalage` (la place d'un cadre dans sa page).
 */
export function rectCapture(rect: RectCss, vue: { largeur: number; hauteur: number }, zoom: number, decalage = { x: 0, y: 0 }): Rectangle {
  const gauche = Math.max(0, Math.round(rect.x * zoom - MARGE_CAPTURE));
  const haut = Math.max(0, Math.round(rect.y * zoom - MARGE_CAPTURE));
  const droite = Math.min(Math.round(vue.largeur * zoom), Math.round((rect.x + rect.largeur) * zoom + MARGE_CAPTURE));
  const bas = Math.min(Math.round(vue.hauteur * zoom), Math.round((rect.y + rect.hauteur) * zoom + MARGE_CAPTURE));
  return { x: gauche + decalage.x, y: haut + decalage.y, width: Math.max(0, droite - gauche), height: Math.max(0, bas - haut) };
}

export async function capturerElement(
  wc: WebContents,
  rect: RectCss,
  vue: { largeur: number; hauteur: number },
  decalage = { x: 0, y: 0 },
): Promise<Buffer | null> {
  if (wc.isDestroyed()) return null;
  try {
    const r = rectCapture(rect, vue, wc.getZoomFactor(), decalage);
    if (r.width <= 0 || r.height <= 0) return null;
    const image = await wc.capturePage(r, { stayHidden: true });
    return image.isEmpty() ? null : image.toPNG();
  } catch {
    return null;
  }
}
