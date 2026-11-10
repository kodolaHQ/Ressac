import { expect, test } from "vitest";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spacePaths } from "../../src/paths.js";
import { readHome } from "../../src/home/read.js";
import { tempFolder } from "../helpers/temp.js";
import { declarationWidget, writeWidget } from "../helpers/home.js";

async function space() {
  const c = spacePaths(await tempFolder());
  await mkdir(c.widgets, { recursive: true });
  const widgetsFolder = await tempFolder();
  return { c, widgetsFolder: widgetsFolder };
}

test("reads the widgets and their placement from layout.json", async () => {
  const { c, widgetsFolder: widgetsFolder } = await space();
  await writeWidget(c, "a");
  await writeWidget(c, "b");
  const layout = { version: 2, widgets: [{ id: "b", x: 0, y: 0, w: 3, h: 2 }, { id: "a", x: 5, y: 1, w: 4, h: 4 }, { id: "fantome", x: 0, y: 9, w: 1, h: 1 }] };
  await writeFile(c.layout, JSON.stringify(layout));
  const state = await readHome(c, widgetsFolder);
  expect(state.widgets.map((w) => w.id)).toEqual(["a", "b"]);
  expect(state.layout).toEqual([
    { id: "b", x: 0, y: 0, w: 3, h: 2 },
    { id: "a", x: 5, y: 1, w: 4, h: 4 },
  ]);
});

test("a widget without a placement is put at the first free spot, at its default size", async () => {
  const { c, widgetsFolder: widgetsFolder } = await space();
  await writeWidget(c, "a", declarationWidget({ w: 4, h: 2 }));
  await writeWidget(c, "b", declarationWidget({ w: 6, h: 3 }));
  await writeWidget(c, "c", declarationWidget({ w: 3, h: 1 }));
  await writeFile(c.layout, JSON.stringify({ version: 2, widgets: [{ id: "a", x: 0, y: 0, w: 4, h: 2 }] }));
  const { layout: layout } = await readHome(c, widgetsFolder);
  expect(layout).toContainEqual({ id: "a", x: 0, y: 0, w: 4, h: 2 });
  expect(layout).toContainEqual({ id: "b", x: 4, y: 0, w: 6, h: 3 });
  expect(layout).toContainEqual({ id: "c", x: 0, y: 2, w: 3, h: 1 }); // 10 + 3 would overflow: next row
});

test("a placement that overlaps or overflows is moved", async () => {
  const { c, widgetsFolder: widgetsFolder } = await space();
  await writeWidget(c, "a");
  await writeWidget(c, "b");
  await writeWidget(c, "c");
  await writeFile(
    c.layout,
    JSON.stringify({ version: 2, widgets: [{ id: "a", x: 0, y: 0, w: 4, h: 4 }, { id: "b", x: 2, y: 2, w: 4, h: 4 }, { id: "c", x: 10, y: 0, w: 4, h: 4 }] }),
  );
  const { layout: layout } = await readHome(c, widgetsFolder);
  expect(layout).toEqual([
    { id: "a", x: 0, y: 0, w: 4, h: 4 },
    { id: "b", x: 4, y: 0, w: 4, h: 4 },
    { id: "c", x: 8, y: 0, w: 4, h: 4 },
  ]);
});

test("an invalid widget.json gives a WidgetLu in error without preventing the others", async () => {
  const { c, widgetsFolder: widgetsFolder } = await space();
  await writeWidget(c, "casse", "{ pas du json");
  await writeWidget(c, "faux", { name: "", sizes: {} });
  await writeWidget(c, "compte-sans-publiques", declarationWidget(undefined, { sources: { account: ["x.test"], public: [] } }));
  await writeWidget(c, "ok");
  const { widgets, layout: layout } = await readHome(c, widgetsFolder);
  const broken = widgets.find((w) => w.id === "casse")!;
  expect("error" in broken && broken.error).toContain("widget.json");
  expect("error" in widgets.find((w) => w.id === "faux")!).toBe(true);
  const account = widgets.find((w) => w.id === "compte-sans-publiques")!;
  expect("declaration" in account && account.declaration.sources).toEqual({ account: ["x.test"], public: [], web: false });
  expect("declaration" in widgets.find((w) => w.id === "ok")!).toBe(true);
  expect(layout.map((p) => p.id).sort()).toEqual(["compte-sans-publiques", "ok"]);
});

test("a layout in the old format ({ ordre }) is ignored: everything is placed again", async () => {
  const { c, widgetsFolder: widgetsFolder } = await space();
  await writeWidget(c, "b", declarationWidget({ w: 6, h: 2 }));
  await writeWidget(c, "a", declarationWidget({ w: 6, h: 2 }));
  await writeFile(c.layout, JSON.stringify({ order: ["b", "a"] }));
  expect((await readHome(c, widgetsFolder)).layout).toEqual([
    { id: "a", x: 0, y: 0, w: 6, h: 2 },
    { id: "b", x: 6, y: 0, w: 6, h: 2 },
  ]);
  await writeFile(c.layout, "n'importe quoi");
  expect((await readHome(c, widgetsFolder)).layout).toHaveLength(2);
});

test("the data and the state come from widgetsFolder, never from the space", async () => {
  const { c, widgetsFolder: widgetsFolder } = await space();
  const state = { status: "error", lastUpdate: null, lastAttempt: "2026-10-28T07:00:00.000Z", error: "boum" };
  await writeWidget(c, "w", declarationWidget(), { "data.json": '{"piege":true}', "state.json": JSON.stringify({ ...state, error: "piège" }) });
  const w0 = (await readHome(c, widgetsFolder)).widgets[0]!;
  expect("data" in w0 && w0.data).toBeNull();
  expect("state" in w0 && w0.state).toEqual({ status: "ok", lastUpdate: null, lastAttempt: null });
  await mkdir(join(widgetsFolder, "w"), { recursive: true });
  await writeFile(join(widgetsFolder, "w", "data.json"), '{"n":1}');
  await writeFile(join(widgetsFolder, "w", "state.json"), JSON.stringify(state));
  const w1 = (await readHome(c, widgetsFolder)).widgets[0]!;
  expect("data" in w1 && w1.data).toEqual({ n: 1 });
  expect("state" in w1 && w1.state).toEqual(state);
});

test("example.json is read; hasHarvest and hasDisplay reflect the files present", async () => {
  const { c, widgetsFolder: widgetsFolder } = await space();
  await writeWidget(c, "nu");
  await writeWidget(c, "complet", declarationWidget(), { "example.json": '{"x":1}', "harvest.mjs": "export default async () => 1", "display.html": "<p>a</p>" });
  const { widgets } = await readHome(c, widgetsFolder);
  const nu = widgets.find((w) => w.id === "nu")!;
  const full = widgets.find((w) => w.id === "complet")!;
  expect("declaration" in nu && [nu.example, nu.hasHarvest, nu.hasDisplay]).toEqual([null, false, false]);
  expect("declaration" in full && [full.example, full.hasHarvest, full.hasDisplay]).toEqual([{ x: 1 }, true, true]);
});

test("hasHarvest true with workflow.json alone; hasWorkflow says so", async () => {
  const { c, widgetsFolder: widgetsFolder } = await space();
  await writeWidget(c, "flux", declarationWidget(), { "workflow.json": '{"version":1,"blocs":[]}' });
  await writeWidget(c, "ancien", declarationWidget(), { "harvest.mjs": "export default async () => 1" });
  const { widgets } = await readHome(c, widgetsFolder);
  const stream = widgets.find((w) => w.id === "flux")!;
  const old = widgets.find((w) => w.id === "ancien")!;
  expect("declaration" in stream && [stream.hasHarvest, stream.hasWorkflow]).toEqual([true, true]);
  expect("declaration" in old && [old.hasHarvest, old.hasWorkflow]).toEqual([true, false]);
});

test("a widget.json that is a symbolic link outside the folder is refused", async () => {
  const { c, widgetsFolder: widgetsFolder } = await space();
  const outside = await tempFolder();
  await writeFile(join(outside, "autre.json"), JSON.stringify(declarationWidget()));
  await mkdir(join(c.widgets, "lien"), { recursive: true });
  await symlink(join(outside, "autre.json"), join(c.widgets, "lien", "widget.json"));
  const w = (await readHome(c, widgetsFolder)).widgets[0]!;
  expect("error" in w).toBe(true);
});

test("widgets folder absent → empty home", async () => {
  const c = spacePaths(await tempFolder());
  expect(await readHome(c, await tempFolder())).toEqual({ layout: [], widgets: [] });
});
