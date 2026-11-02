import type { Rectangle, WebContents } from "electron";
import { HTML_MAX, MARGE_CAPTURE, MONDE_VISEUR, STYLES_UTILES, TRONQUE, tronquerHtml, type ContexteDesign } from "@webaios/noyau";

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
    const selecteurDe = (el) => {
      if (el.id) { const s = "#" + CSS.escape(el.id); if (unique(s, el)) return s; }
      const morceaux = [];
      let n = el;
      while (n && n.nodeType === 1) {
        if (n !== el && n.id && unique("#" + CSS.escape(n.id), n)) { morceaux.unshift("#" + CSS.escape(n.id)); break; }
        if (n === document.documentElement) { morceaux.unshift("html"); break; }
        let rang = 1;
        for (let f = n.previousElementSibling; f; f = f.previousElementSibling) if (f.localName === n.localName) rang++;
        morceaux.unshift(n.localName + ":nth-of-type(" + rang + ")");
        n = n.parentElement;
      }
      return morceaux.join(" > ");
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
    const surSouris = (e) => { bloque(e); };
    const surMove = (e) => { if (e.target instanceof Element) placer(e.target); };
    const fin = (valeur) => {
      for (const t of ["pointerdown", "pointerup", "mousedown", "mouseup", "click"]) window.removeEventListener(t, surSouris, true);
      window.removeEventListener("click", surClic, true);
      window.removeEventListener("mousemove", surMove, true);
      window.removeEventListener("keydown", surTouche, true);
      hote.remove();
      if (globalThis.__viseurArret === arret) delete globalThis.__viseurArret;
      resolve(valeur);
    };
    const arret = () => fin(null);
    const surTouche = (e) => { if (e.key === "Escape") { bloque(e); fin(null); } };
    const surClic = (e) => {
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
    for (const t of ["pointerdown", "pointerup", "mousedown", "mouseup"]) window.addEventListener(t, surSouris, true);
    window.addEventListener("click", surClic, true);
    window.addEventListener("mousemove", surMove, true);
    window.addEventListener("keydown", surTouche, true);
    globalThis.__viseurArret = arret;
  });
})()`;
}

const armes = new Map<WebContents, () => void>();

/** Arme le viseur ; null : Échap, désarmement, navigation ou page détruite. */
export async function armerViseur(wc: WebContents): Promise<CaptureViseur | null> {
  armes.get(wc)?.();
  return new Promise<CaptureViseur | null>((resolve) => {
    let fini = false;
    const surNavigationDetails = (details: { isMainFrame: boolean }) => { if (details.isMainFrame) clore(null); };
    const clore = (v: CaptureViseur | null) => {
      if (fini) return;
      fini = true;
      if (armes.get(wc) === annuler) armes.delete(wc);
      if (!wc.isDestroyed()) {
        wc.off("did-start-navigation", surNavigationDetails);
        wc.off("render-process-gone", surMort);
        wc.off("destroyed", surMort);
      }
      resolve(v ? { ...v, html: tronquerHtml(v.html) } : null);
    };
    const surMort = () => clore(null);
    const annuler = () => clore(null);
    armes.set(wc, annuler);
    wc.on("did-start-navigation", surNavigationDetails);
    wc.on("render-process-gone", surMort);
    wc.on("destroyed", surMort);
    if (wc.isDestroyed()) return clore(null);
    wc.executeJavaScriptInIsolatedWorld(MONDE_VISEUR, [{ code: scriptViseur() }]).then(
      (r) => clore((r as CaptureViseur | null) ?? null),
      () => clore(null),
    );
  });
}

export async function desarmerViseur(wc: WebContents): Promise<void> {
  if (wc.isDestroyed()) return;
  try {
    await wc.executeJavaScriptInIsolatedWorld(MONDE_VISEUR, [{ code: `typeof globalThis.__viseurArret === "function" && globalThis.__viseurArret()` }]);
  } catch {
    // page déjà partie : rien à retirer
  }
  armes.get(wc)?.();
}

/** Source de l'élément, lue dans le monde de la page par une expression sans effet ni global ; null si inconnue. */
export async function lireSource(wc: WebContents, selecteur: string): Promise<ContexteDesign["source"]> {
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
    const r = (await wc.executeJavaScript(code)) as ContexteDesign["source"];
    return r ?? null;
  } catch {
    return null;
  }
}

/** Rect CSS de l'élément élargi de la marge, en pixels de la vue (× zoom), borné à la vue et arrondi. */
export function rectCapture(rect: RectCss, vue: { largeur: number; hauteur: number }, zoom: number): Rectangle {
  const gauche = Math.max(0, Math.round(rect.x * zoom - MARGE_CAPTURE));
  const haut = Math.max(0, Math.round(rect.y * zoom - MARGE_CAPTURE));
  const droite = Math.min(Math.round(vue.largeur * zoom), Math.round((rect.x + rect.largeur) * zoom + MARGE_CAPTURE));
  const bas = Math.min(Math.round(vue.hauteur * zoom), Math.round((rect.y + rect.hauteur) * zoom + MARGE_CAPTURE));
  return { x: gauche, y: haut, width: Math.max(0, droite - gauche), height: Math.max(0, bas - haut) };
}

export async function capturerElement(wc: WebContents, rect: RectCss, vue: { largeur: number; hauteur: number }): Promise<Buffer | null> {
  if (wc.isDestroyed()) return null;
  try {
    const r = rectCapture(rect, vue, wc.getZoomFactor());
    if (r.width <= 0 || r.height <= 0) return null;
    const image = await wc.capturePage(r, { stayHidden: true });
    return image.isEmpty() ? null : image.toPNG();
  } catch {
    return null;
  }
}
