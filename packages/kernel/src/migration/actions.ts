import { join } from "node:path";
import { DeclarationAction } from "../actions/schemas.js";
import { ComponentDeclaration } from "../pages/agent-components.js";
import { PlanPage, readReference } from "../pages/plan.js";
import { filesIn, folders, renameJson, rewriteJson, schemaCheck, type Ctx, type Rule } from "./json.js";
import { VALUES } from "./names.js";
import { GRANTS_RULE, grantsCheck } from "./widgets.js";
import { migrateOwner } from "./workflows.js";

const BUILTINS = new Set(["titre", "paragraphe", "encadre", "chiffre", "chiffres", "liste", "cartes", "tableau", "champs", "etiquettes", "lien", "groupe", "colonnes", "erreur"]);
const OPERATION = /\b(compter|trier|garder|filtrer|regrouper)(\s*\()/g;

/** A reference of the plan's small language with its operations renamed; any other text unchanged. */
function reference(v: unknown): unknown {
  if (typeof v !== "string" || !v.match(OPERATION)) return v;
  const fresh = v.replace(OPERATION, (_, op: string, paren: string) => VALUES[op] + paren);
  return "error" in readReference(fresh) ? v : fresh;
}

type Block = { component?: unknown; props?: unknown; blocks?: unknown; left?: unknown; right?: unknown };

/** A built-in component gets its English name and props; an agent component keeps its own props (agent-defined). */
function planBlocks(list: unknown): unknown {
  if (!Array.isArray(list)) return list;
  return list.map((raw) => {
    const b = renameJson(raw, { opaque: ["props", "blocks", "left", "right"] }) as Block;
    if (typeof b.component === "string" && BUILTINS.has(b.component)) {
      b.component = VALUES[b.component];
      const props = renameJson(b.props, { values: { level: VALUES } }) as Record<string, unknown>;
      for (const [k, v] of Object.entries(props ?? {})) {
        props[k] = Array.isArray(v) ? v.map((x) => (x && typeof x === "object" ? Object.fromEntries(Object.entries(x).map(([a, y]) => [a, reference(y)])) : reference(x))) : reference(v);
      }
      b.props = props;
    }
    for (const k of ["blocks", "left", "right"] as const) if (b[k] !== undefined) b[k] = planBlocks(b[k]);
    return b;
  });
}

const RESULT_RULE: Rule = { opaque: ["results", "plan", "input"], values: { run: (v) => v.replace(/-essai$/, "-attempt") } };
const migratePlan = (v: unknown) => {
  const r = v as { plan?: { blocks?: unknown } | null };
  if (r.plan && typeof r.plan === "object") r.plan = { ...renameJson(r.plan, { opaque: ["blocks"] }) as object, blocks: planBlocks((r.plan as { blocs?: unknown }).blocs ?? r.plan.blocks) };
  return r;
};
const resultCheck = (v: unknown) => {
  const r = v as { version?: unknown; run?: unknown; plan?: unknown };
  if (r.version !== 1 || typeof r.run !== "string") return "résultat invalide";
  return r.plan === null ? null : schemaCheck(PlanPage)(r.plan);
};

export async function migrateActions(ctx: Ctx): Promise<void> {
  const data = join(ctx.dataDir, "actions");
  await rewriteJson(ctx, join(data, "accords.json"), join(data, "grants.json"), GRANTS_RULE, grantsCheck);
  await rewriteJson(ctx, join(data, "refus-lancement.json"), join(data, "launch-denials.json"), { records: { "": null } }, null);
  const files = join(ctx.workspace, "actions");
  const ids = new Set([...(await folders(files)), ...(await folders(data))]);
  for (const id of [...ids].sort()) {
    await rewriteJson(ctx, join(files, id, "action.json"), join(files, id, "action.json"), {}, schemaCheck(DeclarationAction));
    await migrateOwner(ctx, { files: join(files, id), data: join(data, id), widget: false });
    const results = join(data, id, "results");
    for (const f of await filesIn(results)) {
      if (!f.endsWith(".json")) continue;
      const to = join(results, f.replace(/-essai\.json$/, "-attempt.json"));
      await rewriteJson(ctx, join(results, f), to, RESULT_RULE, resultCheck, migratePlan);
    }
  }
}

const COMPONENT_RULE: Rule = { records: { properties: null }, values: { "properties.*.kind": VALUES } };

/** The agent's page components: `component.json` (its `component.html` was renamed with the tree). */
export async function migrateComponents(ctx: Ctx): Promise<void> {
  const root = join(ctx.workspace, "components");
  for (const c of await folders(root)) {
    await rewriteJson(ctx, join(root, c, "composant.json"), join(root, c, "component.json"), COMPONENT_RULE, schemaCheck(ComponentDeclaration));
  }
}
