import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { DeclarationWidget } from "../home/schemas.js";
import { Workflow } from "../workflows/schema.js";
import { DEFAULT_TEMPLATES, languagesOf, ordinaryFile, shippedWidgetFile } from "../workspace/initialize.js";

/** What makes a widget a watch: it notifies, follows the open web, runs at fixed hours, runs long, or streams live. */
function watchTraits(d: DeclarationWidget, workflow: Workflow | null): Set<string> {
  const t = new Set<string>();
  if (d.harvest?.notify === true) t.add("notify");
  if (d.sources.web) t.add("web");
  if (d.harvest?.hours !== undefined) t.add("hours");
  if (d.harvest?.maxDurationMinutes !== undefined) t.add("max-duration");
  if (workflow?.blocks.some((b) => b.type === "output" && b.params.live === true)) t.add("live");
  return t;
}

/** The files that run: the top-level `.mjs` (code blocks name only those) and `workflow.json`. */
async function codeFiles(folder: string): Promise<string[]> {
  return (await readdir(folder).catch(() => [])).filter((n) => n.endsWith(".mjs") || n === "workflow.json");
}

const parseWorkflow = (bytes: Buffer | null): Workflow | null => {
  if (!bytes) return null;
  try {
    return Workflow.parse(JSON.parse(bytes.toString("utf8")));
  } catch {
    return null;
  }
};

/** The watch traits of starter `id`'s templates (any language), or null when `folder` is not an untouched starter's code. */
async function starterTraits(folder: string, id: string, models: string, langs: string[]): Promise<Set<string> | null> {
  const templates = langs.map((l) => join(models, l, "widgets", id)).filter((t) => existsSync(t));
  if (!templates.length) return null;
  const known = new Set((await Promise.all(templates.map((t) => readdir(t)))).flat());
  for (const name of await codeFiles(folder)) {
    if (!known.has(name)) return null;
    const content = await ordinaryFile(join(folder, name));
    if (!content || !(await shippedWidgetFile(models, langs, id, name, content))) return null;
  }
  const traits = new Set<string>();
  for (const t of templates) {
    const declaration = DeclarationWidget.parse(JSON.parse(await readFile(join(t, "widget.json"), "utf8")));
    for (const x of watchTraits(declaration, parseWorkflow(await ordinaryFile(join(t, "workflow.json"))))) traits.add(x);
  }
  return traits;
}

/**
 * Tier 2: an untouched starter (code at a shipped version, no watch trait its template lacks; `widget.json` may differ, the
 * agent sets `config`), or a widget with no code of its own and no watch trait. Tier 3 (needs the lab): agent-written code
 * (a `code` block, `harvest.mjs` alone, an unreadable `workflow.json`) or any watch trait.
 */
export async function widgetTier(o: { folder: string; id: string; declaration: DeclarationWidget; workflow: Workflow | null; models: string; langs: string[] }): Promise<2 | 3> {
  const traits = watchTraits(o.declaration, o.workflow);
  const starter = await starterTraits(o.folder, o.id, o.models, o.langs);
  if (starter) return [...traits].every((t) => starter.has(t)) ? 2 : 3;
  if (traits.size) return 3;
  const hasWorkflow = existsSync(join(o.folder, "workflow.json"));
  // An unreadable workflow.json fails closed: what it would run is unknown.
  if (hasWorkflow) return !o.workflow || o.workflow.blocks.some((b) => b.type === "code") ? 3 : 2;
  return existsSync(join(o.folder, "harvest.mjs")) ? 3 : 2;
}

/**
 * Reads `folder` (a widget's, or its staged copy with `id`) and gives its tier. `declaration`: the one the harvest uses, when
 * the caller already read it. An unreadable `widget.json` without one is tier 2: such a widget is never harvested.
 */
export async function isTier3Widget(folder: string, id = basename(folder), models = DEFAULT_TEMPLATES, declaration?: DeclarationWidget): Promise<boolean> {
  let d = declaration;
  if (!d) {
    try {
      d = DeclarationWidget.parse(JSON.parse((await ordinaryFile(join(folder, "widget.json")))?.toString("utf8") ?? "null"));
    } catch {
      return false;
    }
  }
  const workflow = parseWorkflow(await ordinaryFile(join(folder, "workflow.json")));
  return (await widgetTier({ folder, id, declaration: d, workflow, models, langs: await languagesOf(models) })) === 3;
}
