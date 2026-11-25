import { expect, test } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spacePaths } from "../../src/paths.js";
import { initSpace } from "../../src/workspace/initialize.js";
import { isTier3Widget } from "../../src/widgets/tier.js";
import { declarationWidget, writeWidget } from "../helpers/home.js";
import { tempFolder } from "../helpers/temp.js";

async function space() {
  const c = spacePaths(await tempFolder());
  await initSpace(c, "fr");
  return c;
}

const editJson = async (file: string, f: (j: Record<string, any>) => void) => {
  const j = JSON.parse(await readFile(file, "utf8"));
  f(j);
  await writeFile(file, JSON.stringify(j, null, 2));
};

const feedWorkflow = (extra: Record<string, unknown>[] = [], output: Record<string, unknown> = { to: "widget" }) =>
  JSON.stringify({
    version: 1,
    blocks: [
      { id: "flux", type: "source.feed", params: { urls: ["https://example.org/rss"] } },
      { id: "tri", type: "ai.sort", params: { question: "Intéressant ?", text: "{title}", threshold: 0.6 } },
      ...extra,
      { id: "sortie", type: "output", params: output },
    ],
    links: [
      { from: "flux", to: "tri" },
      { from: "tri", to: "sortie" },
    ],
  });

test("an untouched starter is tier 2", async () => {
  const c = await space();
  for (const id of ["actus-tech", "daily-dev", "meteo"]) expect(await isTier3Widget(join(c.widgets, id)), id).toBe(false);
});

test("an untouched English starter is tier 2", async () => {
  const c = spacePaths(await tempFolder());
  await initSpace(c, "en");
  for (const id of ["actus-tech", "daily-dev", "meteo"]) expect(await isTier3Widget(join(c.widgets, id)), id).toBe(false);
});

test("a starter at an old shipped version is tier 2", async () => {
  const c = await space();
  // meteo/ville.mjs as shipped until 0.1.11 (the engine's object was still called webaios).
  await writeFile(
    join(c.widgets, "meteo", "ville.mjs"),
    `// Weather: the city set, trimmed; null without a city (the geocoding is then not launched).
export default async (_input, webaios) => {
  const city = typeof webaios.config?.ville === "string" ? webaios.config.ville.trim() : "";
  return city ? { ville: city } : null;
};
`,
  );
  expect(await isTier3Widget(join(c.widgets, "meteo"))).toBe(false);
});

test("a starter whose city was set is tier 2", async () => {
  const c = await space();
  await editJson(join(c.widgets, "meteo", "widget.json"), (j) => (j.config.ville = "Lyon"));
  expect(await isTier3Widget(join(c.widgets, "meteo"))).toBe(false);
});

test("a starter with an edited .mjs is tier 3", async () => {
  const c = await space();
  const file = join(c.widgets, "meteo", "ville.mjs");
  await writeFile(file, (await readFile(file, "utf8")) + "\n// edited\n");
  expect(await isTier3Widget(join(c.widgets, "meteo"))).toBe(true);
});

test("a starter with an extra .mjs or an edited workflow.json is tier 3", async () => {
  const c = await space();
  await writeFile(join(c.widgets, "meteo", "harvest.mjs"), "export default () => 1");
  expect(await isTier3Widget(join(c.widgets, "meteo"))).toBe(true);
  await editJson(join(c.widgets, "daily-dev", "workflow.json"), (j) => j.blocks.push({ id: "extra", type: "code", params: { source: "liens.mjs" } }));
  expect(await isTier3Widget(join(c.widgets, "daily-dev"))).toBe(true);
});

test("a starter that gained notify is tier 3", async () => {
  const c = await space();
  await editJson(join(c.widgets, "meteo", "widget.json"), (j) => (j.harvest.notify = true));
  expect(await isTier3Widget(join(c.widgets, "meteo"))).toBe(true);
});

test("a starter that gained web is tier 3; actus-tech's own web stays tier 2", async () => {
  const c = await space();
  await editJson(join(c.widgets, "meteo", "widget.json"), (j) => (j.sources.web = true));
  expect(await isTier3Widget(join(c.widgets, "meteo"))).toBe(true);
  expect(await isTier3Widget(join(c.widgets, "actus-tech"))).toBe(false);
});

test("an agent widget with only source.feed, ai.sort and output is tier 2", async () => {
  const c = await space();
  await writeWidget(c, "veille-lucie", declarationWidget(undefined, { harvest: { minutes: 60 }, sources: { public: ["example.org"] } }), { "workflow.json": feedWorkflow() });
  expect(await isTier3Widget(join(c.widgets, "veille-lucie"))).toBe(false);
});

test("an agent widget with a code block is tier 3", async () => {
  const c = await space();
  await writeWidget(c, "code-camille", declarationWidget(undefined, { harvest: { minutes: 60 } }), {
    "workflow.json": feedWorkflow([{ id: "calcul", type: "code", params: { source: "calcul.mjs" } }]),
    "calcul.mjs": "export default (x) => x",
  });
  expect(await isTier3Widget(join(c.widgets, "code-camille"))).toBe(true);
});

test("harvest.mjs alone is tier 3", async () => {
  const c = await space();
  await writeWidget(c, "seul", declarationWidget(undefined, { harvest: { minutes: 60 } }), { "harvest.mjs": "export default () => 1" });
  expect(await isTier3Widget(join(c.widgets, "seul"))).toBe(true);
});

test("an unreadable workflow.json is tier 3", async () => {
  const c = await space();
  await writeWidget(c, "casse", declarationWidget(undefined, { harvest: { minutes: 60 } }), { "workflow.json": "{ pas du json" });
  expect(await isTier3Widget(join(c.widgets, "casse"))).toBe(true);
});

test("each watch trait alone is tier 3", async () => {
  const c = await space();
  const traits: [string, Record<string, unknown>, string?][] = [
    ["notify", { harvest: { minutes: 60, notify: true } }],
    ["web", { harvest: { minutes: 60 }, sources: { web: true } }],
    ["hours", { harvest: { hours: ["08:00"] } }],
    ["max-duration", { harvest: { minutes: 60, maxDurationMinutes: 10 } }],
    ["live", { harvest: { minutes: 60 } }, feedWorkflow([], { to: "widget", live: true })],
  ];
  for (const [id, extra, workflow] of traits) {
    await writeWidget(c, id, declarationWidget(undefined, extra), { "workflow.json": workflow ?? feedWorkflow() });
    expect(await isTier3Widget(join(c.widgets, id)), id).toBe(true);
  }
});
