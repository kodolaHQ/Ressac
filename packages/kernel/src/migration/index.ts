import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_MODELS } from "../workspace/initialize.js";
import { migrateActions, migrateComponents } from "./actions.js";
import { migrateDesign } from "./design.js";
import { defaultDocker, migrateDocker, type DockerRunner } from "./docker.js";
import { migrateExtensions } from "./extensions.js";
import { migrateHistory } from "./history.js";
import { kind, type Ctx } from "./json.js";
import { FutureFormatError, KNOWN_FORMAT, readMarker, writeMarkerHalf } from "./marker.js";
import { migrateProfiles } from "./profiles.js";
import { REPORT_FILE, writeReport } from "./report.js";
import { migrateSites } from "./sites.js";
import { migrateTree } from "./tree.js";
import { verify } from "./verify.js";
import { migrateWidgets } from "./widgets.js";

export { FutureFormatError, KNOWN_FORMAT, readMarker, writeMarkerHalf, type Marker } from "./marker.js";
export type { DockerRunner } from "./docker.js";

export type MigrationResult = { status: "done" | "already"; report: string | null };

/** Old data while the store half (and its backup) has not run: nothing is migrated. */
export class StoreNotMigratedError extends Error {
  constructor() {
    super("Les données sont encore au format d'avant et le navigateur n'en a pas fait la copie de sauvegarde : rien n'est migré.");
    this.name = "StoreNotMigratedError";
  }
}

const oldData = async (dataDir: string) =>
  (await kind(join(dataDir, "espace"))) !== null || (await kind(join(dataDir, "historique.sqlite"))) !== null;

/**
 * The kernel half of the English formats migration, run by the host before anything else (before initSpace and
 * before the history opens). Every step recognizes the old and the new format, so a run cut at any point is
 * simply run again; the marker `kernel: 2` is written last. `checkpoint`: called after each write (tests cut there).
 */
export async function migrateKernel(o: {
  dataDir: string;
  docker?: DockerRunner;
  now?: () => Date;
  models?: string;
  checkpoint?: (label: string) => void | Promise<void>;
}): Promise<MigrationResult> {
  const marker = await readMarker(o.dataDir);
  if (marker.store > KNOWN_FORMAT || marker.kernel > KNOWN_FORMAT) throw new FutureFormatError(marker);
  if (marker.kernel >= KNOWN_FORMAT) return { status: "already", report: null };
  const old = await oldData(o.dataDir);
  if (marker.store < KNOWN_FORMAT) {
    if (old) throw new StoreNotMigratedError();
    // A new data folder: nothing to migrate; the store half writes its marker first.
    return { status: "already", report: null };
  }
  const reportFile = join(o.dataDir, REPORT_FILE);
  // No old data (and no cut run, which leaves its report): the data is already in the new format. Renaming it again
  // would rename the user's own names that match old ones (a workflow field `avis`, a `{titre}` template).
  if (!old && (await kind(reportFile)) === null) {
    await writeMarkerHalf(o.dataDir, "kernel", KNOWN_FORMAT);
    return { status: "already", report: null };
  }
  for (const name of ["espace", "workspace"]) {
    // A linked workspace would make every step write outside the data folder.
    if ((await kind(join(o.dataDir, name))) === "other") throw new Error(`${join(o.dataDir, name)} n'est pas un dossier (lien ?) : rien n'est migré.`);
  }
  const ctx: Ctx = {
    dataDir: o.dataDir,
    workspace: join(o.dataDir, "workspace"),
    now: (o.now ?? (() => new Date()))(),
    changed: 0,
    unreadable: [],
    conflicts: [],
    resign: [],
    dockerErrors: [],
    written: [],
    checkpoint: async (label) => void (await o.checkpoint?.(label)),
  };
  // Its presence says, after a cut, that old data was found: the full report is then written again at the end.
  if (old && (await kind(reportFile)) === null) await writeFile(reportFile, "# Passage des données aux noms anglais : en cours\n");
  const models = o.models ?? DEFAULT_MODELS;
  const steps: [string, () => Promise<void>][] = [
    ["tree", () => migrateTree(ctx)],
    ["widgets", () => migrateWidgets(ctx, models)],
    ["actions", () => migrateActions(ctx)],
    ["components", () => migrateComponents(ctx)],
    ["sites", () => migrateSites(ctx)],
    ["extensions", () => migrateExtensions(ctx)],
    ["design", () => migrateDesign(ctx)],
    ["profiles", () => migrateProfiles(ctx)],
    ["history", () => migrateHistory(ctx)],
    ["docker", () => migrateDocker(ctx, o.docker ?? defaultDocker)],
  ];
  for (const [name, step] of steps) {
    await step();
    await ctx.checkpoint(name);
  }
  const failures = await verify(ctx);
  const issues = ctx.unreadable.length + ctx.conflicts.length + ctx.dockerErrors.length + failures.length;
  const report = ctx.changed > 0 || issues > 0 || (await kind(reportFile)) !== null ? await writeReport(ctx, failures) : null;
  await ctx.checkpoint("report");
  await writeMarkerHalf(o.dataDir, "kernel", KNOWN_FORMAT);
  return { status: "done", report };
}
