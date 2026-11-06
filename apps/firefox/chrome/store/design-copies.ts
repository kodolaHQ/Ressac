// The design mode's pure pieces of Electron (apps/navigateur/src/main/design/viseur.ts, frozen): imported where they are
// exported, copied word for word where they are not (test/design-copies.test.ts checks the copies against Electron's text).
import { tronquerHtml, type ContexteDesign } from "../../../../packages/noyau/src/design/remarques";
import { scriptViseur, type CaptureViseur } from "../../../navigateur/src/main/design/viseur";

export { rectCapture } from "../../../navigateur/src/main/design/viseur";
export type { CaptureViseur };

export const SOURCE_TIMEOUT_MS = 1500;

/**
 * Electron's scriptViseur without its own click listener: the actor's guard (design-actor.ts), in front of every page
 * listener, hands it the clicked element through `globalThis.__viseurChoisir`, which `fin` deletes with `__viseurArret`.
 * Hover, Escape, swallowing and stop stay Electron's code. Throws when Electron's text changes.
 */
export function firefoxViewfinderScript(): string {
  let s = scriptViseur();
  const edits: [string, string][] = [
    ['      window.removeEventListener("click", surClic, true);\n', ""],
    ["if (globalThis.__viseurArret === arret) delete globalThis.__viseurArret;", "if (globalThis.__viseurArret === arret) { delete globalThis.__viseurArret; delete globalThis.__viseurChoisir; }"],
    ["const surClic = (e) => {\n      if (!e.isTrusted) return;\n      bloque(e);\n      const el = e.target;", "const choisir = (el) => {"],
    ['window.addEventListener("click", surClic, true);', "globalThis.__viseurChoisir = choisir;"],
  ];
  for (const [a, b] of edits) {
    if (!s.includes(a)) throw new Error(`scriptViseur changed: ${a}`);
    s = s.replace(a, b);
  }
  return s;
}

// Electron's ARRET, not exported there.
export const STOP_SCRIPT = `typeof globalThis.__viseurArret === "function" && globalThis.__viseurArret(); typeof globalThis.__viseurAvaler === "function" && globalThis.__viseurAvaler()`;

// Copied from viseur.ts, word for word (names included): not exported there.
const fini = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const chaine = (c: unknown, max = 1_000_000): c is string => typeof c === "string" && c.length <= max;
const entierPositif = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n > 0;

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

/** Ce qui vient du monde de la page n'est jamais cru : fichier court, numéros entiers positifs, le reste est écarté. */
function sourceSaine(r: unknown): ContexteDesign["source"] {
  const o = r as { fichier?: unknown; ligne?: unknown; colonne?: unknown } | null;
  if (!o || typeof o !== "object" || !chaine(o.fichier, 1024) || o.fichier === "") return null;
  return { fichier: o.fichier, ...(entierPositif(o.ligne) ? { ligne: o.ligne } : {}), ...(entierPositif(o.colonne) ? { colonne: o.colonne } : {}) };
}

/** What armerViseur does with the script's answer: the shape checked, the html cut. */
export function cleanCapture(v: unknown): CaptureViseur | null {
  const c = propreCapture(v);
  return c ? { ...c, html: tronquerHtml(c.html) } : null;
}

export const cleanSource = (r: unknown): ContexteDesign["source"] => sourceSaine(r);

/** lireSource's expression (Electron's main world; here the actor's sandbox with Xrays waived): no effect, no global. */
export function sourceExpression(selecteur: string): string {
  return `(() => {
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
}
