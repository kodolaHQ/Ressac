import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Marionette } from "./marionette";
import { click, inUi, waitUi } from "./ui";

/** A widget's folder in the space: `<dataDir>/espace/accueil/widgets/<id>`. */
export const widgetDir = (dataDir: string, id: string) => path.join(dataDir, "espace", "accueil", "widgets", id);

/** A display that shows the data it gets by postMessage (`#donnees`). */
const DISPLAY = `<!doctype html><meta charset="utf-8"><pre id="donnees"></pre>
<script>
  addEventListener("message", (e) => {
    if (!e.data || e.data.type !== "widget") return;
    document.getElementById("donnees").textContent = JSON.stringify(e.data.donnees);
  });
</script>`;

/**
 * Writes a widget before launch: its declaration (`declaration` merged over the defaults), a display, its workflow and
 * code files if given, and an « up to date now » state so the scheduler does not harvest it at launch.
 */
export async function writeWidget(
  dataDir: string,
  id: string,
  o: { name: string; workflow?: unknown; harvest?: Record<string, unknown>; declaration?: Record<string, unknown>; files?: Record<string, string> },
): Promise<void> {
  const dir = widgetDir(dataDir, id);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "widget.json"),
    JSON.stringify({
      name: o.name,
      description: "",
      sizes: { min: { l: 2, h: 1 }, max: { l: 6, h: 4 }, default: { l: 3, h: 2 } },
      sources: { account: [], public: [], web: false },
      ...(o.harvest ? { harvest: o.harvest } : {}),
      ...o.declaration,
    }),
  );
  await writeFile(path.join(dir, "display.html"), DISPLAY);
  if (o.workflow !== undefined) await writeFile(path.join(dir, "workflow.json"), typeof o.workflow === "string" ? o.workflow : JSON.stringify(o.workflow));
  for (const [name, text] of Object.entries(o.files ?? {})) await writeFile(path.join(dir, name), text);
  const state = path.join(dataDir, "widgets", id);
  await mkdir(state, { recursive: true });
  const now = new Date().toISOString();
  await writeFile(path.join(state, "etat.json"), JSON.stringify({ status: "ok", lastUpdate: now, lastAttempt: now }));
}

/** The widget's workflow.json as on disk. */
export async function readWorkflow(dataDir: string, id: string): Promise<any> {
  return JSON.parse(await readFile(path.join(widgetDir(dataDir, id), "workflow.json"), "utf8"));
}

/** « Voir / modifier le workflow » from the widget's menu on the home page; waits for the builder. */
export async function openBuilder(m: Marionette, id: string): Promise<void> {
  await click(m, `[data-testid="widget-${id}"] button[aria-label="Options du widget"]`);
  await click(m, '[role="menuitem"]', { text: "Voir / modifier le workflow" });
  await waitUi(m, "return !!doc.querySelector('[data-testid=\"constructeur\"]')");
}

/** The ids of the canvas's visible nodes. */
export function nodes(m: Marionette): Promise<string[]> {
  return inUi(m, "return [...doc.querySelectorAll('.svelte-flow__node')].filter((n) => n.getBoundingClientRect().width > 0).map((n) => n.dataset.id)");
}
