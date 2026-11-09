import { HTML_MAX, MARGE_CAPTURE, STYLES_UTILES, TRUNCATED, type DesignContext } from "@webaios/noyau";

export interface CaptureViseur extends Omit<DesignContext, "source"> {
  rect: { x: number; y: number; largeur: number; hauteur: number };
}
type RectCss = CaptureViseur["rect"];

/**
 * Isolated world code: sets up the targeter, resolves with the click's capture (or null: Esc, stop). The stop is exposed
 * in a variable of the isolated world (`__viseurArret`), invisible to the page. The page sees no mouse event.
 */
export function scriptViseur(): string {
  return `(() => {
  if (typeof globalThis.__viseurArret === "function") globalThis.__viseurArret();
  // A new arming removes the click swallowing left by the previous capture: it has its own listeners.
  if (typeof globalThis.__viseurAvaler === "function") globalThis.__viseurAvaler();
  const STYLES = ${JSON.stringify(STYLES_UTILES)};
  const HTML_MAX = ${HTML_MAX};
  const TRONQUE = ${JSON.stringify(TRUNCATED)};
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
    // Events made by the page (isTrusted false) pass untouched: only the user's count.
    const surSouris = (e) => { if (e.isTrusted) bloque(e); };
    // While aiming, « click » is handled apart (surClic); swallow it alone after the capture.
    const TYPES_VISEE = ["pointerdown", "pointerup", "mousedown", "mouseup", "auxclick", "contextmenu", "dblclick"];
    const TYPES_SOURIS = ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "auxclick", "contextmenu", "dblclick"];
    const surMove = (e) => { if (e.target instanceof Element) placer(e.target); };
    const fin = (valeur) => {
      for (const t of TYPES_SOURIS) window.removeEventListener(t, surSouris, true);
      window.removeEventListener("click", surClic, true);
      if (valeur) {
        // The end of a double click (second click, dblclick) must not reach the page.
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

/**
 * CSS rect of the element widened by the margin, in view pixels (× zoom), bounded to the view and rounded, then shifted by
 * `decalage` (the position of a frame in its page).
 */
export function rectCapture(rect: RectCss, vue: { largeur: number; hauteur: number }, zoom: number, decalage = { x: 0, y: 0 }): { x: number; y: number; width: number; height: number } {
  const gauche = Math.max(0, Math.round(rect.x * zoom - MARGE_CAPTURE));
  const haut = Math.max(0, Math.round(rect.y * zoom - MARGE_CAPTURE));
  const droite = Math.min(Math.round(vue.largeur * zoom), Math.round((rect.x + rect.largeur) * zoom + MARGE_CAPTURE));
  const bas = Math.min(Math.round(vue.hauteur * zoom), Math.round((rect.y + rect.hauteur) * zoom + MARGE_CAPTURE));
  return { x: gauche + Math.round(decalage.x * zoom), y: haut + Math.round(decalage.y * zoom), width: Math.max(0, droite - gauche), height: Math.max(0, bas - haut) };
}
