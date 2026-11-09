import { join } from "node:path";
import { Manifest } from "../applications/manifest.js";
import { filesIn, folders, rewriteJson, schemaCheck, type Ctx, type Rule } from "./json.js";
import { VALUES } from "./names.js";

/** A remark (design or review): its `context.styles` is CSS (property names), never renamed. */
const ELEMENT = { opaque: ["context.styles", "context.html"], values: { type: VALUES } };
const BASKET_RULE: Rule = { opaque: ["*.context.styles", "*.context.html"], values: { "*.type": VALUES } };
const BATCH_RULE: Rule = {
  opaque: ELEMENT.opaque.map((p) => `items.*.${p}`),
  values: { origin: VALUES, "items.*.type": VALUES },
};

/** Remarks of one store (`<dataDir>/design/remarks` or the workspace's `.webaios/remarks`): baskets and batches. */
async function remarks(ctx: Ctx, root: string): Promise<void> {
  for (const project of await folders(root)) {
    const p = join(root, project);
    await rewriteJson(ctx, join(p, "panier.json"), join(p, "basket.json"), BASKET_RULE, null);
    for (const batch of await folders(p)) {
      await rewriteJson(ctx, join(p, batch, "lot.json"), join(p, batch, "batch.json"), BATCH_RULE, null);
    }
  }
}

/** Design mode and review: external registry, remarks, review comments; the agent's apps' `webaios.json`. */
export async function migrateDesign(ctx: Ctx): Promise<void> {
  const design = join(ctx.dataDir, "design");
  await rewriteJson(ctx, join(design, "projets-externes.json"), join(design, "external-projects.json"), {}, null);
  await rewriteJson(ctx, join(design, "clients-externes.json"), join(design, "external-clients.json"), {}, null);
  await remarks(ctx, join(design, "remarks"));
  await remarks(ctx, join(ctx.workspace, ".webaios", "remarks"));
  const review = join(design, "review");
  for (const f of await filesIn(review)) {
    if (f.endsWith(".commentaires.json")) await rewriteJson(ctx, join(review, f), join(review, f.replace(/\.commentaires\.json$/, ".comments.json")), {}, null);
  }
  const projects = join(ctx.workspace, "projects");
  for (const p of await folders(projects)) {
    const file = join(projects, p, "webaios.json");
    await rewriteJson(ctx, file, file, { values: { type: VALUES } }, schemaCheck(Manifest));
  }
}
