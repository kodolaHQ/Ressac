import { KEYS } from "./names.js";

type Names = Readonly<Record<string, string>>;

/**
 * How one JSON format is renamed. Paths use the NEW key names joined by dots; an array element or a child of a
 * record (dynamic keys: ids, origins) is `*`. Every other key goes through KEYS (or `keys` first).
 */
export interface Rule {
  keys?: Names;
  /** Subtrees left untouched: free content (config, data, outputs, results). */
  opaque?: readonly string[];
  /** Objects keyed by ids: their keys stay (or go through the given map, e.g. a profile id). */
  records?: Readonly<Record<string, Names | null>>;
  /** String values renamed at a path. */
  values?: Readonly<Record<string, Names | ((v: string) => string)>>;
}

const at = (path: string, k: string) => (path ? `${path}.${k}` : k);

export function renameJson(v: unknown, r: Rule, path = ""): unknown {
  if (r.opaque?.includes(path)) return v;
  const map = r.values?.[path];
  if (map && typeof v === "string") return typeof map === "function" ? map(v) : (map[v] ?? v);
  if (Array.isArray(v)) return v.map((x) => renameJson(x, r, at(path, "*")));
  if (v === null || typeof v !== "object") return v;
  const record = r.records && path in r.records ? (r.records[path] ?? {}) : null;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) {
    const key = record ? (record[k] ?? k) : (r.keys?.[k] ?? KEYS[k] ?? k);
    out[key] = renameJson(x, r, at(path, record ? "*" : key));
  }
  return out;
}
