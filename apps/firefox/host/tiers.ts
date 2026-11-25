import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { SpacePaths } from "../../../packages/kernel/src/index.ts";

/**
 * A session saved before tiers: the user already uses the lab when the agent is in Atelier, or the workspace holds an
 * action, a site app, a component or a tier-3 widget. Empty folders do not count (initSpace makes them), nor hidden
 * names (.DS_Store). readdir never follows links; a widget link is not a widget folder.
 */
export async function labInUse(paths: SpacePaths, agentMode: "browser" | "workshop", isTier3Widget: (folder: string) => Promise<boolean>): Promise<boolean> {
  if (agentMode === "workshop") return true;
  for (const dir of [paths.actions, paths.sites, paths.components]) if ((await readdir(dir).catch(() => [])).some((n) => !n.startsWith("."))) return true;
  for (const w of await readdir(paths.widgets, { withFileTypes: true }).catch(() => [])) if (w.isDirectory() && !w.name.startsWith(".") && (await isTier3Widget(join(paths.widgets, w.name)))) return true;
  return false;
}
