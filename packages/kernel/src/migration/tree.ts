import { rm } from "node:fs/promises";
import { join } from "node:path";
import { folders, move, type Ctx } from "./json.js";

/**
 * Folder renames of the data tree (FOLDERS), outermost first. The JSON files inside are renamed by their own step,
 * which also rewrites them; code files only change name.
 */
export async function migrateTree(ctx: Ctx): Promise<void> {
  const d = ctx.dataDir;
  const w = ctx.workspace;
  await move(ctx, join(d, "espace"), w);
  for (const [from, to] of [
    ["profilage", "profiling"],
    ["ia-locale", "local-ai"],
    ["local-ai/kev.clone-en-cours", "local-ai/kev.clone-in-progress"],
    ["design/remarques", "design/remarks"],
    ["design/relecture", "design/review"],
    ["extensions/signes", "extensions/signed"],
  ]) {
    await move(ctx, join(d, from!), join(d, to!));
  }
  // Disposable copies (rebuilt from the workspace at each start): the old cache name would stay orphaned.
  await rm(join(d, "webaios-composants"), { recursive: true, force: true });

  for (const [from, to] of [
    ["accueil", "home"],
    ["home/blocs", "home/blocks"],
    ["home/.corbeille", "home/.trash"],
    ["composants", "components"],
    ["projets", "projects"],
    ["actions/.corbeille", "actions/.trash"],
    ["sites/.corbeille", "sites/.trash"],
    [".webaios/profils", ".webaios/profiles"],
    [".webaios/journaux", ".webaios/logs"],
    [".webaios/remarques", ".webaios/remarks"],
    [".webaios/profilage", ".webaios/profiling"],
  ]) {
    await move(ctx, join(w, from!), join(w, to!));
  }
  for (const p of await folders(join(w, "projects"))) {
    await move(ctx, join(w, "projects", p, ".webaios", "profilage"), join(w, "projects", p, ".webaios", "profiling"));
  }
  for (const c of await folders(join(w, "components"))) {
    await move(ctx, join(w, "components", c, "composant.html"), join(w, "components", c, "component.html"));
  }
  for (const s of await folders(join(w, "sites"))) {
    await move(ctx, join(w, "sites", s, "accueil"), join(w, "sites", s, "home"));
    await move(ctx, join(w, "sites", s, "retouches"), join(w, "sites", s, "tweaks"));
  }
  // The user's widget files before initSpace, which knows only the new names.
  for (const id of await folders(join(w, "home", "widgets"))) {
    for (const [from, to] of [
      ["recolte.mjs", "harvest.mjs"],
      ["affichage.html", "display.html"],
      ["exemple.json", "example.json"],
    ]) {
      await move(ctx, join(w, "home", "widgets", id, from!), join(w, "home", "widgets", id, to!));
    }
  }
  for (const owner of ["widgets", "actions"]) {
    for (const id of await folders(join(d, owner))) {
      await move(ctx, join(d, owner, id, "donnees.json"), join(d, owner, id, "data.json"));
      await move(ctx, join(d, owner, id, "executions"), join(d, owner, id, "runs"));
      await move(ctx, join(d, owner, id, "resultats"), join(d, owner, id, "results"));
    }
  }
}
