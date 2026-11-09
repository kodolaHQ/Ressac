// Templates of text params: `{path}` replaced by a value of the current item (or of the input), or of the
// user's config (`{config.…}`). `{path?}` is optional: an absent value becomes an empty
// string (for an enrichment, like a reliability). For an action run with an input, the exact marker `{input}`
// (or `{input?}`) is that input, before an `input` field of the item. No expressions: nothing is ever evaluated.

const PATTERN = /\{([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)(\?)?\}/g;
const ALONE = /^\{[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*\??\}$/;

/** Value at the end of a path `a.b.0`; own properties only (never those of the prototype). */
export function readPath(value, path) {
  let v = value;
  for (const piece of path.split(".")) {
    if (v === null || typeof v !== "object" || !Object.hasOwn(v, piece)) return undefined;
    v = v[piece];
  }
  return v;
}

const absent = (v) => v === undefined || v === null || v === "";
const asText = (v) => (typeof v === "string" ? v : typeof v === "object" ? JSON.stringify(v) : String(v));

/**
 * Fills in a template. Returns `{ text }`, or `{ missing: path }` at the first absent, `null` or empty value of a
 * `{path}` marker; an optional marker `{path?}` without a value is replaced by an empty string.
 * `input` (text, action only): the value of `{input}`; without it, `{input}` reads the item as before.
 * `url`: each value is encoded, unless the template is exactly one `{path}` (a whole URL).
 * `maxText`: each inserted value is cut to this length.
 */
export function fill(template, { item, config, input }, { url = false, maxText = Infinity } = {}) {
  const encode = url && !ALONE.test(template);
  let missing = null;
  const text = template.replace(PATTERN, (all, path, optional) => {
    if (missing) return all;
    const v =
      path === "input" && typeof input === "string"
        ? input
        : path.startsWith("config.")
          ? readPath(config, path.slice("config.".length))
          : readPath(item, path);
    if (absent(v)) {
      if (optional) return "";
      missing = path;
      return all;
    }
    const t = asText(v).slice(0, maxText);
    return encode ? encodeURIComponent(t) : t;
  });
  return missing ? { missing } : { text };
}

/** Thrown by `ctx.fill`: the interpreter runs nothing for this item (or returns `null` in simple mode). */
export class MissingValue extends Error {
  constructor(path) {
    super(`valeur absente : ${path}`);
    this.path = path;
  }
}
