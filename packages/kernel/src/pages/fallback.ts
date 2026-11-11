import type { PlanBlock, PlanPage } from "./plan.js";

// The fallback layout, without Gemma: a simple presentation of the results, made of built-in components.
// It only references paths that exist and that the reference language can write; it passes validatePlan.

type Dict = Record<string, unknown>;
const isObject = (v: unknown): v is Dict => v !== null && typeof v === "object" && !Array.isArray(v);
const WORD = /^[\p{L}\p{N}_]+$/u;
const simple = (v: unknown) => typeof v === "string" || typeof v === "number" || typeof v === "boolean";
const IMAGE = /\.(?:jpe?g|png|webp|gif)(?:\?[^\s]*)?$/i;
const IMAGE_NAMES = ["image", "photo", "vignette"];
const LINK_NAMES = ["url", "lien", "href"];
const TITLE_NAMES = ["titre", "title", "nom", "name", "libelle", "label"];
const VALUE_NAMES = ["prix", "price", "valeur", "montant"];
const SAMPLE = 20;
/** A plain text longer than this (or on several lines) gets a section of its own instead of a line in the fields. */
const SHORT_MAX = 120;
/** The catalog's bound on the fields of one `fields` block. */
const FIELDS_MAX = 12;
const COLUMNS = 6;
const KEYS_MAX = 12;
const TITLE_MAX = 80;
const LABEL_MAX = 60;

const cut = (s: string, max: number) => (s.length > max ? s.slice(0, max - 1) + "…" : s);
const block = (component: string, props: Record<string, unknown>): PlanBlock => ({ component: component, props });
const keyValid = (k: string) => WORD.test(k);
const byName = (fieldList: string[], names: string[]) => fieldList.find((c) => names.includes(c.toLowerCase()));

/** A key as a label: camelCase and snake_case split, first letter capitalized, acronyms kept (« viewCount » → « View count »). */
export function humanize(key: string): string {
  const words = key
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2")
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => (w.length > 1 && w === w.toUpperCase() ? w : w.toLowerCase()));
  const s = words.join(" ");
  return s ? cut(s.charAt(0).toUpperCase() + s.slice(1), LABEL_MAX) : cut(key, LABEL_MAX);
}
const section = (key: string) => block("title", { text: cut(humanize(key), TITLE_MAX) });
const isUrl = (v: unknown) => typeof v === "string" && /^https?:\/\/\S+$/i.test(v);

/** The plain fields (text, number, boolean) of a list of objects, in order of appearance. */
function simpleFields(elements: Dict[]): { field: string; imageUrl: boolean; text: boolean }[] {
  const seen = new Map<string, { imageUrl: boolean; text: boolean }>();
  for (const e of elements.slice(0, SAMPLE)) {
    for (const k of Object.keys(e)) {
      if (!keyValid(k) || !simple(e[k])) continue;
      const v = e[k];
      const f = seen.get(k) ?? { imageUrl: false, text: false };
      if (typeof v === "string") {
        f.text = true;
        if (v.startsWith("https://") && IMAGE.test(v)) f.imageUrl = true;
      }
      seen.set(k, f);
    }
  }
  return [...seen].map(([field, f]) => ({ field: field, ...f }));
}

/** The block of a list referenced by `ref`, or null if nothing readable. */
function listBlock(list: unknown[], ref: string): PlanBlock | null {
  if (list.length === 0) return null;
  const sample = list.slice(0, SAMPLE);
  if (sample.every(simple)) return block("tags", { values: ref });
  const objects = sample.filter(isObject);
  if (objects.length === 0) return null;
  const fieldList = simpleFields(objects);
  if (fieldList.length === 0) return null;
  const names = fieldList.map((c) => c.field);
  const link = byName(names, LINK_NAMES);
  const image = byName(names, IMAGE_NAMES) ?? fieldList.find((c) => c.imageUrl)?.field;
  if (image) {
    const texts = fieldList.filter((c) => c.text && c.field !== image && c.field !== link).map((c) => c.field);
    const title = byName(texts, TITLE_NAMES) ?? texts[0] ?? names.find((n) => n !== image) ?? image;
    const subtitle = texts.find((c) => c !== title);
    const value = byName(names, VALUE_NAMES);
    const props: Record<string, unknown> = { items: ref, title: title, image };
    if (subtitle) props.subtitle = subtitle;
    if (value && value !== title) props.value = value;
    if (link) props.link = link;
    return block("cards", props);
  }
  // A single plain field ([{ text: "…" }]): bullets, not a one-column table.
  if (names.length === 1) return block("list", { items: ref, title: names[0] });
  const props: Record<string, unknown> = {
    items: ref,
    columns: names.slice(0, COLUMNS).map((field) => ({ field: field, label: cut(field, LABEL_MAX) })),
  };
  if (link) props.link = link;
  return block("table", props);
}

function objectBlocks(o: Dict): PlanBlock[] {
  const keys = Object.keys(o).filter(keyValid).slice(0, KEYS_MAX * 2);
  const short = (k: string) => {
    const v = o[k];
    if (typeof v === "string") return v !== "" && !isUrl(v) && v.length <= SHORT_MAX && !v.includes("\n");
    return typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v));
  };
  const links = keys.filter((k) => isUrl(o[k]));
  // The link carries the title when there is one: the title is not repeated in the fields.
  const linkTitle = links.length > 0 ? byName(keys.filter(short).filter((k) => typeof o[k] === "string"), TITLE_NAMES) : undefined;
  const fieldKeys = keys.filter((k) => short(k) && k !== linkTitle);
  const blocks: PlanBlock[] = [block("title", { text: "Résultats" })];
  for (const k of links) blocks.push(block("link", linkTitle ? { object: "$", url: k, textField: linkTitle } : { object: "$", url: k }));
  for (let i = 0; i < fieldKeys.length; i += FIELDS_MAX) {
    const fields = fieldKeys.slice(i, i + FIELDS_MAX).map((k) => ({ field: k, label: humanize(k) }));
    blocks.push(block("fields", { object: "$", fields: fields }));
  }
  for (const key of keys) {
    if (blocks.length >= KEYS_MAX * 2) break;
    const v = o[key];
    if (typeof v === "string" && v !== "" && !short(key) && !isUrl(v)) blocks.push(section(key), block("paragraph", { value: key }));
    else if (Array.isArray(v)) {
      const b = listBlock(v, key);
      if (b) blocks.push(section(key), b);
    } else if (isObject(v)) {
      if (Object.keys(v).some((k) => keyValid(k) && simple(v[k]))) blocks.push(section(key), block("fields", { object: key }));
    }
  }
  // Keys that a reference cannot write: their plain fields are read through the whole object.
  const reference = () => blocks.some((b) => b.component !== "title");
  if (Object.keys(o).some((k) => !keyValid(k) && simple(o[k]))) blocks.push(block("fields", { object: "$" }));
  if (!reference()) blocks.push(LAST_RESORT);
  return blocks;
}

/** The last resort: all the results in a bounded text. Reference "$", so always valid. */
const LAST_RESORT = block("paragraph", { value: "$" });
export const lastResortLayout = (): PlanPage => ({ blocks: [{ ...LAST_RESORT, props: { ...LAST_RESORT.props } }] });

export function fallbackLayout(results: unknown): PlanPage {
  if (Array.isArray(results)) {
    const b = listBlock(results, "$");
    return b ? { blocks: [b] } : lastResortLayout();
  }
  if (isObject(results)) return { blocks: objectBlocks(results) };
  if (typeof results === "number") return { blocks: [block("figure", { value: "$", label: "Résultat" })] };
  if (simple(results)) return { blocks: [block("paragraph", { value: "$" })] };
  return lastResortLayout();
}
