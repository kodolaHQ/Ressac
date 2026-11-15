// The preview of the results given to Gemma: their shape (each path and its type) and a few examples, bounded. Pure.
// The results are facts read from web pages: the preview is data, never an instruction.

export const PREVIEW_MAX = 6000;
const EXAMPLE_ELEMENTS = 3;
const EXAMPLE_TEXT = 120;
const KEYS_MAX = 30;
const SAMPLE = 20;
const SAMPLE_NODES_MAX = 400;
const DESCRIPTION_MAX = 300;
const PATH_MAX = 80;

type Dict = Record<string, unknown>;
const isObject = (v: unknown): v is Dict => v !== null && typeof v === "object" && !Array.isArray(v);

/** A dictionary without a prototype: a « __proto__ » key of the results stays a key like any other. */
const dict = (): Dict => Object.create(null) as Dict;

function cut(s: string, max: number): string {
  if (s.length <= max) return s;
  let end = max;
  const c = s.charCodeAt(end - 1);
  if (c >= 0xd800 && c <= 0xdbff) end--;
  return s.slice(0, end) + "…";
}

function kindOf(v: unknown): string {
  if (v === null || v === undefined) return "vide";
  if (typeof v === "string") return "texte";
  if (typeof v === "number") return "nombre";
  if (typeof v === "boolean") return "booléen";
  if (Array.isArray(v)) return "liste";
  return "objet";
}

/** The type of a value in one line: the fields of a list of objects are detailed, the rest stays short. */
function describe(v: unknown): string {
  if (Array.isArray(v)) {
    if (v.length === 0) return "liste (0)";
    const sample = v.slice(0, SAMPLE);
    if (sample.every(isObject)) {
      const fieldList = new Map<string, string>();
      for (const e of sample) {
        for (const k of Object.keys(e).slice(0, KEYS_MAX)) if (!fieldList.has(k)) fieldList.set(k, kindOf(e[k]));
      }
      const detail = [...fieldList].slice(0, KEYS_MAX).map(([k, t]) => `${cut(k, 40)}: ${t}`).join(", ");
      return `liste (${v.length}) d'objets { ${detail} }`;
    }
    const natures = new Set(sample.map(kindOf));
    if (natures.size === 1) {
      const n = [...natures][0]!;
      return `liste (${v.length}) de ${n === "texte" ? "textes" : n === "nombre" ? "nombres" : n === "booléen" ? "booléens" : n === "liste" ? "listes" : "valeurs"}`;
    }
    return `liste (${v.length}) de valeurs`;
  }
  if (isObject(v)) {
    const keys = Object.keys(v);
    return `objet { ${keys.slice(0, KEYS_MAX).map((k) => cut(k, 40)).join(", ")}${keys.length > KEYS_MAX ? ", …" : ""} }`;
  }
  return kindOf(v);
}

/** Each path and its type, the objects being walked down to `profondeur` levels. */
function forme(root: unknown, depth: number): Dict {
  const f = dict();
  const ask = (path: string, v: unknown) => { f[cut(path, PATH_MAX)] = cut(describe(v), DESCRIPTION_MAX); };
  if (!isObject(root)) {
    ask("$", root);
    return f;
  }
  const stack: { v: Dict; prefix: string; level: number }[] = [{ v: root, prefix: "", level: 1 }];
  while (stack.length > 0) {
    const { v, prefix, level } = stack.shift()!;
    for (const k of Object.keys(v).slice(0, KEYS_MAX)) {
      const path = prefix + k;
      const e = v[k];
      ask(path, e);
      if (isObject(e) && level < depth) stack.push({ v: e, prefix: path + ".", level: level + 1 });
    }
  }
  return f;
}

/** A reduced copy: 3 items per list, texts at 120, `profondeur` levels, a bounded number of nodes. */
function examples(root: unknown, depth: number): unknown {
  let nodes = 0;
  const copy = (v: unknown, level: number): unknown => {
    if (++nodes > SAMPLE_NODES_MAX) return "…";
    if (typeof v === "string") return cut(v, EXAMPLE_TEXT);
    if (typeof v === "number") return Number.isFinite(v) ? v : null;
    if (typeof v === "boolean" || v === null) return v;
    if (v === undefined) return null;
    if (level >= depth) return Array.isArray(v) ? `[liste (${v.length})]` : "[objet]";
    if (Array.isArray(v)) return v.slice(0, EXAMPLE_ELEMENTS).map((e) => copy(e, level + 1));
    const o = dict();
    for (const k of Object.keys(v as Dict).slice(0, KEYS_MAX)) o[cut(k, 40)] = copy((v as Dict)[k], level + 1);
    return o;
  };
  return copy(root, 0);
}

/** JSON `{ forme, exemples }` of at most PREVIEW_MAX characters: the examples go first, then the deep levels. */
export function resultsPreview(results: unknown): string {
  const attempts: [number, boolean][] = [[4, true], [3, true], [2, true], [4, false], [3, false], [2, false], [1, false]];
  for (const [depth, withExamples] of attempts) {
    const s = JSON.stringify(withExamples ? { shape: forme(results, depth), examples: examples(results, depth) } : { shape: forme(results, depth) });
    if (s.length <= PREVIEW_MAX) return s;
  }
  // Last resort: the first paths only.
  const f = forme(results, 1);
  const kept = dict();
  for (const k of Object.keys(f)) {
    kept[k] = f[k];
    if (JSON.stringify({ shape: kept }).length > PREVIEW_MAX) {
      delete kept[k];
      break;
    }
  }
  return JSON.stringify({ shape: kept });
}

/** `null`, `""`, `[]`, `{}`, or an object whose values are all empty (recursively). Iterative. */
export function emptyResults(r: unknown): boolean {
  const stack: unknown[] = [r];
  while (stack.length > 0) {
    const v = stack.pop();
    if (v === null || v === undefined || v === "") continue;
    if (Array.isArray(v)) {
      if (v.length === 0) continue;
      return false;
    }
    if (typeof v === "object") {
      for (const k of Object.keys(v)) stack.push((v as Record<string, unknown>)[k]);
      continue;
    }
    return false;
  }
  return true;
}
