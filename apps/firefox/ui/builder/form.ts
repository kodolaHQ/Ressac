import type { BlockCatalogEntry } from "@ressac/kernel";

export type FormField = BlockCatalogEntry["fields"][number];

/**
 * Fields shown for these parameters: the « per item only » ones wait for `perItem` to be checked. A block that
 * always works item by item (`ai.sort`) has no such mark in the catalog: its fields are always there.
 */
export function shownFields(c: BlockCatalogEntry, params: Record<string, unknown>): FormField[] {
  return c.fields.filter((f) => !f.perItemOnly || params.perItem === true);
}

/** Value shown by the field: the block's, otherwise the catalog's default value. */
export function entryOf(f: FormField, params: Record<string, unknown>): unknown {
  return Object.hasOwn(params, f.name) ? params[f.name] : f.default;
}

/** Text of a value in a text, template, number or texts field (one line per value). */
export function textOf(f: FormField, v: unknown): string {
  if (v === undefined || v === null) return "";
  if (f.kind === "texts") return Array.isArray(v) ? v.map((x) => String(x)).join("\n") : String(v);
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

/**
 * The parameters with the field's new value (typed text, or a checkbox's boolean); null if the input means nothing
 * (unreadable number, or required number emptied). An emptied non-required field removes its key; a required text
 * stays empty (the validator will say so). An unchecked non-required checkbox without a default value (absent =
 * false) also removes its key.
 */
export function paramsWith(params: Record<string, unknown>, f: FormField, input: string | boolean): Record<string, unknown> | null {
  const { [f.name]: _old, ...without } = params;
  if (typeof input === "boolean") return !input && !f.required && f.default === undefined ? without : { ...params, [f.name]: input };
  let v: unknown;
  if (f.kind === "number") {
    // Required, an emptied number changes nothing (the block keeps its value until a number is typed).
    if (input.trim() === "") return f.required ? null : without;
    v = Number(input.trim().replace(",", "."));
    if (!Number.isFinite(v)) return null;
  } else if (f.kind === "texts") {
    const lines = input.split("\n").map((l) => l.trim()).filter((l) => l !== "");
    if (lines.length === 0 && !f.required) return without;
    v = lines;
  } else {
    if (input === "" && !f.required) return without;
    v = input;
  }
  // The order of the file's keys is kept.
  return { ...params, [f.name]: v };
}
