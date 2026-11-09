import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { BLOCK_REGISTRY } from "../workflows/blocks/index.js";
import { Execution } from "../workflows/executions.js";
import { canonicalJson, paramsHash } from "../workflows/memory.js";
import { Workflow } from "../workflows/schema.js";
import { implicitWorkflow } from "../workflows/validate.js";
import { filesIn, kind, parse, readNoFollow, renameJson, rewrite, rewriteJson, schemaCheck, stringify, type Ctx, type Rule } from "./json.js";
import { BLOCK_TYPES, ENGINE_API, ENGINE_FIELDS, KEYS, VALUES } from "./names.js";

type Params = Record<string, unknown>;
type RawBlock = { id?: unknown; type?: unknown; params?: unknown; parametres?: unknown };

const blockType = (t: string) => BLOCK_TYPES[t] ?? t;
const suffix = (id: string) => id.replace(/-essai$/, "-attempt");

/** A data path (`page.texte`): each engine field renamed; `config.…` is the user's config, never renamed. */
function fieldPath(path: string): string {
  const parts = path.split(".");
  if (parts[0] === "config") return path;
  return parts.map((p) => ENGINE_FIELDS[p] ?? p).join(".");
}

/** `{titre}`, `{page.texte?}`, `{saisie}` → `{title}`, `{page.text?}`, `{input}`. */
const template = (t: string) =>
  t.replace(/\{([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)(\?)?\}/g, (all, path: string, optional = "") =>
    ENGINE_API[`{${path}}`] ? `${ENGINE_API[`{${path}}`]!.slice(0, -1)}${optional}}` : `{${fieldPath(path)}${optional}}`,
  );

/** The params of a block: keys, enum values, field paths and the templates of its text fields. */
function migrateParams(type: string, p: Params): Params {
  const def = BLOCK_REGISTRY.get(type);
  const templates = new Set(def?.fields.filter((f) => f.kind === "template").map((f) => f.name));
  const out: Params = {};
  for (const [k, v] of Object.entries(p)) {
    const key = KEYS[k] ?? k;
    let value = v;
    if (typeof v === "string") {
      if (templates.has(key)) value = template(v);
      else if (key === "field" || key === "reuse" || key === "key") value = fieldPath(v);
      else if (key === "source") value = v === "recolte.mjs" ? "harvest.mjs" : v;
      else if (key === "onError" || key === "format" || key === "call") value = VALUES[v] ?? v;
    } else if (key === "keys" && Array.isArray(v)) value = v.map((x) => (typeof x === "string" ? fieldPath(x) : x));
    out[key] = value;
  }
  return out;
}

const blocksOf = (w: unknown): RawBlock[] => {
  const o = w as { blocks?: unknown; blocs?: unknown } | null;
  const b = o?.blocs ?? o?.blocks;
  return Array.isArray(b) ? (b as RawBlock[]) : [];
};

export function migrateWorkflow(old: unknown): unknown {
  const w = renameJson(old, { opaque: ["blocks.*.params"] }) as { blocks?: unknown };
  for (const b of blocksOf(w)) {
    if (typeof b.type === "string") b.type = blockType(b.type);
    if (b.params && typeof b.params === "object") b.params = migrateParams(String(b.type), b.params as Params);
  }
  return w;
}

/** The old validated params: the defaults of the French blocks, which the old hash was computed on. */
const PER_ITEM = { parElement: false, siErreur: "sauter" };
const OLD_DEFAULTS: Record<string, Params> = {
  "source.page": { compte: false, champ: "page", ...PER_ITEM },
  "source.flux": { siErreur: "sauter" },
  "source.recuperer": { format: "texte", champ: "contenu", ...PER_ITEM },
  "web.chercher": { nombre: 8, champ: "recherche", ...PER_ITEM },
  "ia.trier": { seuil: 0.5, champ: "p", siErreur: "sauter" },
  "ia.rediger": { champ: "texte", json: false, texteMax: 12_000, ...PER_ITEM },
  code: { appel: "entree" },
  sortie: { vers: "widget" },
};

function oldParamsHash(type: string, p: Params): string {
  const { garderJours: _keepDays, ...settings } = { ...OLD_DEFAULTS[type], ...p };
  return createHash("sha256").update(canonicalJson(settings)).digest("hex").slice(0, 16);
}

function newParamsHash(type: string, p: Params): string | null {
  const r = BLOCK_REGISTRY.get(type)?.params.safeParse(p);
  return r?.success ? paramsHash(r.data as Params) : null;
}

const OLD_IMPLICIT = {
  blocs: [
    { id: "recolte", type: "code", parametres: { source: "recolte.mjs", appel: "recolte" } },
    { id: "sortie", type: "sortie", parametres: { vers: "widget" } },
  ],
};
const IMPLICIT_IDS: Record<string, string> = { recolte: "harvest", sortie: "output" };

/**
 * `memory.json` of an owner. Each entry gets the new type; its hash is recomputed on the migrated params only if it
 * matched the old params (else the entry goes: a stale memory is never validated). An entry without a hash or
 * without its block is kept.
 */
function migrateMemory(old: unknown, oldWorkflow: unknown, newWorkflow: unknown, implicit: boolean): unknown {
  const m = old as { version?: unknown; blocs?: Record<string, unknown>; blocks?: Record<string, unknown> };
  const entries = m.blocs ?? m.blocks ?? {};
  const before = new Map(blocksOf(oldWorkflow).map((b) => [b.id, b]));
  const after = new Map(blocksOf(newWorkflow).map((b) => [b.id, b]));
  const blocks: Record<string, unknown> = {};
  for (const [oldId, raw] of Object.entries(entries)) {
    const e = renameJson(raw, { opaque: ["value"] }) as { type?: unknown; value?: unknown; hash?: unknown };
    const id = implicit ? (IMPLICIT_IDS[oldId] ?? oldId) : oldId;
    if (typeof e.type === "string") e.type = blockType(e.type);
    const value = e.value as Record<string, unknown> | null;
    if (value && typeof value === "object" && !Array.isArray(value) && "reutilises" in value) {
      e.value = Object.fromEntries(Object.entries(value).map(([k, v]) => [k === "reutilises" ? "reused" : k, v]));
    }
    const ob = before.get(oldId);
    const nb = after.get(id);
    if (typeof e.hash === "string" && ob && nb && "parametres" in ob) {
      const stamped = oldParamsHash(String(ob.type), (ob.parametres ?? {}) as Params) === e.hash;
      const fresh = stamped ? newParamsHash(String(nb.type), (nb.params ?? {}) as Params) : null;
      if (fresh === null) continue;
      e.hash = fresh;
    }
    blocks[id] = e;
  }
  return { version: m.version ?? 1, blocks };
}

const RUN_RULE: Rule = {
  opaque: ["blocks.*.output", "input"],
  values: {
    id: suffix,
    status: VALUES,
    trigger: VALUES,
    "blocks.*.status": VALUES,
    "blocks.*.type": blockType,
    "attempt.origin": suffix,
  },
};

const memoryCheck = (v: unknown) => {
  const m = v as { version?: unknown; blocks?: unknown };
  return m?.version === 1 && m.blocks && typeof m.blocks === "object" ? null : "memory.json invalide";
};

async function readJsonIfAny(p: string): Promise<unknown> {
  if ((await kind(p)) !== "file") return undefined;
  try {
    return JSON.parse((await readNoFollow(p)).toString());
  } catch {
    return undefined;
  }
}

/**
 * One owner (widget or action): its memory first (it needs the old workflow), then `workflow.json`, then its runs.
 * `replacement`: the shipped template that takes the place of an untouched starter workflow.
 */
export async function migrateOwner(
  ctx: Ctx,
  o: { files: string; data: string; widget: boolean; replacement?: (text: Buffer) => Promise<Buffer | null> },
): Promise<void> {
  const workflowFile = join(o.files, "workflow.json");
  const oldWorkflow = await readJsonIfAny(workflowFile);
  const implicit = o.widget && oldWorkflow === undefined && (await kind(join(o.files, "harvest.mjs"))) === "file";
  let newWorkflow: unknown;
  if (implicit) newWorkflow = implicitWorkflow();
  else if (oldWorkflow !== undefined) {
    const shipped = o.replacement ? await o.replacement(await readNoFollow(workflowFile)) : null;
    newWorkflow = shipped ? JSON.parse(shipped.toString()) : migrateWorkflow(oldWorkflow);
  }
  const memory = join(o.data, "memory.json");
  await rewrite(ctx, join(o.data, "memoire.json"), memory, (t) =>
    stringify(migrateMemory(parse(t), implicit ? OLD_IMPLICIT : oldWorkflow, newWorkflow, implicit), t),
  );
  if (await kind(memory)) ctx.written.push({ path: memory, check: memoryCheck });

  if (oldWorkflow !== undefined) {
    await rewrite(ctx, workflowFile, workflowFile, async (t) => {
      const shipped = o.replacement ? await o.replacement(t) : null;
      return shipped ?? stringify(migrateWorkflow(parse(t)), t);
    });
    ctx.written.push({ path: workflowFile, check: schemaCheck(Workflow) });
  }

  const runs = join(o.data, "runs");
  for (const f of await filesIn(runs)) {
    if (!f.endsWith(".json")) continue;
    await rewriteJson(ctx, join(runs, f), join(runs, suffix(f.slice(0, -5)) + ".json"), RUN_RULE, schemaCheck(Execution));
  }
}

/** The current template of a starter file, if `text` is one of its shipped versions. */
export function shippedReplacement(models: string, shipped: ReadonlySet<string> | undefined, templateFile: string) {
  return async (text: Buffer): Promise<Buffer | null> => {
    if (!shipped?.has(createHash("sha256").update(text).digest("hex"))) return null;
    return readFile(join(models, templateFile));
  };
}
