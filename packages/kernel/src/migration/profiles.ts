import { createHash } from "node:crypto";
import { join } from "node:path";
import { Profile } from "../profiles/profile.js";
import { OLD_AGENT_PROFILE } from "../workspace/initialize.js";
import { filesIn, kind, readNoFollow, rewriteJson, schemaCheck, type Ctx, type Rule } from "./json.js";

const prompt = (v: string) => (v === "{consigne}" ? "{prompt}" : v);
const RULE: Rule = { values: { "interactive.*": prompt, "nonInteractive.*": prompt } };

/** The agent CLI profiles (`.webaios/profiles/*.json`). A copy left as shipped is not touched: initSpace replaces it. */
export async function migrateProfiles(ctx: Ctx): Promise<void> {
  const folder = join(ctx.workspace, ".webaios", "profiles");
  for (const f of await filesIn(folder)) {
    const file = join(folder, f);
    if (!f.endsWith(".json") || (await kind(file)) !== "file") continue;
    const shipped = OLD_AGENT_PROFILE.has(createHash("sha256").update(await readNoFollow(file).catch(() => Buffer.alloc(0))).digest("hex"));
    if (!shipped) await rewriteJson(ctx, file, file, RULE, schemaCheck(Profile));
  }
}
