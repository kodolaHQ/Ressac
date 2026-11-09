import { join } from "node:path";
import { DeclarationWidget, FreeLayout, Layout, WidgetState } from "../home/schemas.js";
import { HomeTheme } from "../home/theme.js";
import { Grant } from "../widgets/grants.js";
import { STARTER_SHIPPED } from "../workspace/initialize.js";
import { fixedPoint, folders, parse, renameJson, rewrite, rewriteJson, schemaCheck, stringify, type Check, type Ctx, type Rule } from "./json.js";
import { KEY_EXCEPTIONS, VALUES } from "./names.js";
import { migrateOwner, shippedReplacement } from "./workflows.js";

const PROFILE = { defaut: "default" };

/** `grants.json` of widgets or actions: `{ <id>: { domains, public, profile } }`. */
export const GRANTS_RULE: Rule = { records: { "": null }, values: { "*.profile": PROFILE } };
export const grantsCheck: Check = (v) =>
  Object.values(v as Record<string, unknown>).every((g) => Grant.safeParse(g).success) ? null : "accord invalide";

const STATE_RULE: Rule = { values: { status: VALUES, "before.status": VALUES } };
const WIDGET_RULE: Rule = { opaque: ["config"] };
const layoutCheck: Check = (v) => {
  const version = (v as { version?: unknown }).version;
  if (version === 2) return schemaCheck(Layout)(v);
  return version === 3 ? schemaCheck(FreeLayout)(v) : null; // another version: initSpace sets it aside
};

/** A JSON file of the workspace: replaced by its template while untouched since shipped, else renamed. */
async function starterOrRename(ctx: Ctx, from: string, to: string, rule: Rule, check: Check | null, models: string, key: string, template: string) {
  const replacement = shippedReplacement(models, STARTER_SHIPPED[key], template);
  await rewrite(ctx, from, to, async (t) => (await replacement(t)) ?? stringify(renameJson(parse(t), rule), t));
  ctx.written.push({ path: to, check: (v) => (fixedPoint(v, rule) ? null : "anciens noms restants") ?? check?.(v) ?? null });
}

/** The home page: layout, theme, each widget's files in the workspace and its data outside it. */
export async function migrateWidgets(ctx: Ctx, models: string): Promise<void> {
  const home = join(ctx.workspace, "home");
  await starterOrRename(ctx, join(home, "disposition.json"), join(home, "layout.json"), {}, layoutCheck, models, "layout.json", "layout.json");
  await rewriteJson(ctx, join(home, "theme.json"), join(home, "theme.json"), { keys: KEY_EXCEPTIONS.theme }, schemaCheck(HomeTheme));
  const widgets = join(ctx.dataDir, "widgets");
  await rewriteJson(ctx, join(widgets, "accords.json"), join(widgets, "grants.json"), GRANTS_RULE, grantsCheck);

  const ids = new Set([...(await folders(join(home, "widgets"))), ...(await folders(widgets))]);
  for (const id of [...ids].sort()) {
    const files = join(home, "widgets", id);
    const starter = (name: string) => `widgets/${id}/${name}`;
    await starterOrRename(ctx, join(files, "widget.json"), join(files, "widget.json"), WIDGET_RULE, schemaCheck(DeclarationWidget), models, starter("widget.json"), starter("widget.json"));
    // Starter sample data and code left as shipped: the current template (same names, English fields and API).
    for (const [key, name] of [["exemple.json", "example.json"], ...["articles.mjs", "liens.mjs", "prevision.mjs", "ville.mjs"].map((f) => [f, f])]) {
      const file = join(files, name!);
      const replacement = shippedReplacement(models, STARTER_SHIPPED[starter(key!)], starter(name!));
      await rewrite(ctx, file, file, async (t) => (await replacement(t)) ?? t);
    }
    const data = join(widgets, id);
    await rewriteJson(ctx, join(data, "etat.json"), join(data, "state.json"), STATE_RULE, schemaCheck(WidgetState));
    await migrateOwner(ctx, {
      files,
      data,
      widget: true,
      replacement: shippedReplacement(models, STARTER_SHIPPED[starter("workflow.json")], starter("workflow.json")),
    });
  }
}
