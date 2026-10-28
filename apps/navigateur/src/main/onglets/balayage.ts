import type { WebContents } from "electron";

/**
 * Balayer à deux doigts pour reculer ou avancer, comme Chrome et Safari. Chromium ne le fait pas seul dans Electron :
 * un script, dans un monde isolé de la page, suit les défilements horizontaux. Quand rien dans la page ne peut plus
 * défiler dans ce sens, il cumule le mouvement, montre une flèche au bord, puis navigue au-delà du seuil.
 */

/** Monde isolé du balayage (999 sert aux lectures de texte). */
const MONDE_BALAYAGE = 1001;
/** Mouvement horizontal cumulé qui déclenche la navigation (px). */
export const SEUIL_BALAYAGE = 160;
/** Sans défilement pendant ce temps (ms), le geste est fini : l'élan qui suit une navigation ne compte pas. */
export const PAUSE_GESTE = 300;

export interface EtatBalayage {
  cumul: number;
  dernier: number;
  /** Le geste a déjà navigué : le reste (élan compris) est ignoré jusqu'à la pause. */
  fait: boolean;
}

export interface Roue {
  dx: number;
  dy: number;
  /** La page a pris le défilement : elle défile dans ce sens, ou l'a empêché, ou c'est un zoom. */
  pris: boolean;
  t: number;
}

export interface Possible {
  reculer: boolean;
  avancer: boolean;
}

export const ETAT_BALAYAGE: EtatBalayage = { cumul: 0, dernier: -Infinity, fait: false };

/**
 * Une étape du geste. `progression` va de -1 (reculer) à 1 (avancer), pour la flèche. Autonome (seuil et pause en
 * paramètres) : sa source est injectée telle quelle dans la page.
 */
export function etapeBalayage(
  etat: EtatBalayage,
  r: Roue,
  possible: Possible,
  seuil = SEUIL_BALAYAGE,
  pause = PAUSE_GESTE,
): { etat: EtatBalayage; action: "reculer" | "avancer" | null; progression: number } {
  const suite = r.t - etat.dernier <= pause;
  let cumul = suite ? etat.cumul : 0;
  const fait = suite ? etat.fait : false;
  if (fait) return { etat: { cumul: 0, dernier: r.t, fait }, action: null, progression: 0 };
  if (r.pris || Math.abs(r.dy) > Math.abs(r.dx)) cumul = 0;
  else cumul = cumul !== 0 && Math.sign(cumul) !== Math.sign(r.dx) ? r.dx : cumul + r.dx;
  const sens = cumul < 0 ? "reculer" : "avancer";
  if (cumul === 0 || !possible[sens]) return { etat: { cumul: 0, dernier: r.t, fait: false }, action: null, progression: 0 };
  if (Math.abs(cumul) >= seuil) return { etat: { cumul: 0, dernier: r.t, fait: true }, action: sens, progression: 0 };
  return { etat: { cumul, dernier: r.t, fait: false }, action: null, progression: cumul / seuil };
}

/** Le script de la page : installé une fois par document, il ne fait que mettre à jour `possible` ensuite. */
function script(possible: Possible): string {
  return `(() => {
  const possible = ${JSON.stringify(possible)};
  if (globalThis.__balayage) { globalThis.__balayage.possible = possible; return; }
  const etape = (etat, r, p) => (${etapeBalayage.toString()})(etat, r, p, ${SEUIL_BALAYAGE}, ${PAUSE_GESTE});
  const b = (globalThis.__balayage = { possible, etat: { cumul: 0, dernier: -Infinity, fait: false } });
  let hote = null, fleche = null, fin = 0;
  const montrer = (p) => {
    if (!hote) {
      hote = document.createElement("div");
      const ombre = hote.attachShadow({ mode: "closed" });
      fleche = document.createElement("div");
      fleche.style.cssText = "position:fixed;top:50%;width:44px;height:44px;margin-top:-22px;border-radius:50%;" +
        "background:rgba(60,60,67,.85);color:#fff;font:600 22px/44px -apple-system,system-ui,sans-serif;text-align:center;" +
        "z-index:2147483647;pointer-events:none;transition:opacity .15s";
      ombre.append(fleche);
    }
    if (!hote.isConnected) document.documentElement.append(hote);
    const a = Math.min(1, Math.abs(p));
    fleche.textContent = p < 0 ? "←" : "→";
    fleche.style.left = p < 0 ? (-44 + a * 64) + "px" : "";
    fleche.style.right = p < 0 ? "" : (-44 + a * 64) + "px";
    fleche.style.opacity = String(a);
  };
  const cacher = () => { if (hote) hote.remove(); };
  const defile = (el, dx) => {
    for (let n = el instanceof Element ? el : document.scrollingElement; n; n = n.parentElement) {
      if (n.scrollWidth <= n.clientWidth + 1) continue;
      const racine = n === document.scrollingElement || n === document.body;
      const o = getComputedStyle(n).overflowX;
      if (!racine && o !== "auto" && o !== "scroll") continue;
      if (dx < 0 ? n.scrollLeft > 0 : n.scrollLeft + n.clientWidth < n.scrollWidth - 1) return true;
    }
    return false;
  };
  addEventListener("wheel", (e) => {
    const dx = e.deltaMode === 1 ? e.deltaX * 16 : e.deltaX;
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    const pris = e.defaultPrevented || e.ctrlKey || defile(e.target, dx);
    const r = etape(b.etat, { dx, dy, pris, t: performance.now() }, b.possible);
    b.etat = r.etat;
    clearTimeout(fin);
    if (r.action) { cacher(); r.action === "reculer" ? history.back() : history.forward(); return; }
    if (r.progression) { montrer(r.progression); fin = setTimeout(cacher, ${PAUSE_GESTE}); } else cacher();
  }, { passive: true });
})();`;
}

/** Branche le balayage sur une page web : à chaque document et à chaque changement de son historique. */
export function brancherBalayage(wc: WebContents): void {
  const installer = () => {
    if (wc.isDestroyed()) return;
    const possible = { reculer: wc.navigationHistory.canGoBack(), avancer: wc.navigationHistory.canGoForward() };
    wc.executeJavaScriptInIsolatedWorld(MONDE_BALAYAGE, [{ code: script(possible) }]).catch(() => {});
  };
  wc.on("dom-ready", installer);
  wc.on("did-navigate-in-page", (_e, _url, principal) => principal && installer());
}
