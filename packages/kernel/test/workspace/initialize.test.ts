import { expect, test, vi } from "vitest";
import { existsSync, readdirSync } from "node:fs";
import { chmod, cp, lstat, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spacePaths } from "../../src/paths.js";
import { initSpace, DEFAULT_MODELS, HARVESTS_SHIPPED, DISPLAYS_SHIPPED, OLD_AGENTS } from "../../src/workspace/initialize.js";
import { createHash } from "node:crypto";
import { DeclarationWidget, Layout } from "../../src/home/schemas.js";
import { DeclarationSite, checkSiteDeclaration } from "../../src/sites/schemas.js";
import { readReference } from "../../src/pages/plan.js";
import { tempFolder } from "../helpers/temp.js";

const sha256 = (content: string | Buffer) => createHash("sha256").update(content).digest("hex");

/** The starter widgets' files in a new space: workflows, without recolte.mjs. */
const START_FILES: Record<string, string[]> = {
  meteo: ["widget.json", "exemple.json", "affichage.html", "workflow.json", "ville.mjs", "prevision.mjs"],
  "actus-tech": ["widget.json", "exemple.json", "affichage.html", "workflow.json", "articles.mjs"],
  "daily-dev": ["widget.json", "exemple.json", "affichage.html", "workflow.json", "liens.mjs", "articles.mjs"],
};
/** The switch code: workflow.json and the template's .mjs files. */
const START_CODE = (id: string) => START_FILES[id]!.filter((f) => f === "workflow.json" || f.endsWith(".mjs"));

const expectedList = [
  "AGENTS.md",
  "CLAUDE.md",
  "accueil/disposition.json",
  ...Object.entries(START_FILES).flatMap(([w, files]) => files.map((f) => `accueil/widgets/${w}/${f}`)),
  ".webaios/profils/claude.json",
];

test("creates the full space in an empty folder", async () => {
  const c = spacePaths(await tempFolder());
  const { crees } = await initSpace(c);
  for (const f of expectedList) expect(existsSync(join(c.racine, f)), f).toBe(true);
  expect(existsSync(c.projets)).toBe(true);
  expect(existsSync(c.extensions)).toBe(true);
  expect(existsSync(c.actions)).toBe(true);
  expect(existsSync(c.sites)).toBe(true);
  expect(existsSync(c.composants)).toBe(true);
  expect(crees.length).toBe(expectedList.length);
});

test("never overwrites an existing file", async () => {
  const c = spacePaths(await tempFolder());
  await mkdir(c.accueil, { recursive: true });
  const personal = '{"version":2,"widgets":[]}';
  await writeFile(join(c.racine, "AGENTS.md"), "perso");
  await writeFile(c.disposition, personal);
  const { crees } = await initSpace(c);
  expect(await readFile(join(c.racine, "AGENTS.md"), "utf8")).toBe("perso");
  expect(await readFile(c.disposition, "utf8")).toBe(personal);
  expect(crees).not.toContain(join(c.racine, "AGENTS.md"));
  expect(crees).not.toContain(c.disposition);
});

test("idempotent: a second call creates nothing", async () => {
  const c = spacePaths(await tempFolder());
  await initSpace(c);
  expect((await initSpace(c)).crees).toEqual([]);
});

test("AGENTS.md mentions the required elements", async () => {
  const c = spacePaths(await tempFolder());
  await initSpace(c);
  const text = await readFile(join(c.racine, "AGENTS.md"), "utf8");
  for (const m of ["page_courante", "ouvrir_onglet", "5280", "5299", "0.0.0.0", "etat.json", "/workspace/projets"]) {
    expect(text, m).toContain(m);
  }
});

test("a new space gets the three starter widgets and the v2 layout", async () => {
  const c = spacePaths(await tempFolder());
  await initSpace(c);
  expect((await readdir(c.widgets)).sort()).toEqual(["actus-tech", "daily-dev", "meteo"]);
  expect(existsSync(c.blocs)).toBe(false);
  const available = Layout.parse(JSON.parse(await readFile(c.disposition, "utf8")));
  expect(available.widgets.map((w) => w.id)).toEqual(["actus-tech", "daily-dev", "meteo"]);
  for (const id of ["meteo", "actus-tech", "daily-dev"]) {
    const d = DeclarationWidget.parse(JSON.parse(await readFile(join(c.widgets, id, "widget.json"), "utf8")));
    JSON.parse(await readFile(join(c.widgets, id, "exemple.json"), "utf8"));
    if (id !== "meteo") expect(JSON.stringify(d.config)).toContain("sécurité informatique");
  }
  const daily = DeclarationWidget.parse(JSON.parse(await readFile(join(c.widgets, "daily-dev", "widget.json"), "utf8")));
  expect(daily.sources.compte).toEqual(["app.daily.dev"]);
});

test("existing blocks move to accueil/.corbeille/blocs-…, nothing is destroyed", async () => {
  const c = spacePaths(await tempFolder());
  await mkdir(join(c.blocs, "mien"), { recursive: true });
  await writeFile(join(c.blocs, "mien", "bloc.json"), '{"a":1}');
  await writeFile(c.disposition, '{"ordre":["mien"]}');
  await initSpace(c);
  expect(existsSync(c.blocs)).toBe(false);
  const trash = join(c.accueil, ".corbeille");
  const folders = await readdir(trash);
  expect(folders).toHaveLength(1);
  expect(folders[0]).toMatch(/^blocs-\d{4}-\d\d-\d\dT[^:]+$/);
  expect(await readFile(join(trash, folders[0]!, "mien", "bloc.json"), "utf8")).toBe('{"a":1}');
  expect(await readFile(join(trash, folders[0]!, "disposition.json"), "utf8")).toBe('{"ordre":["mien"]}');
  expect(Layout.safeParse(JSON.parse(await readFile(c.disposition, "utf8"))).success).toBe(true);
  expect(existsSync(join(c.widgets, "meteo", "widget.json"))).toBe(true);
  // A second launch sets nothing aside.
  await initSpace(c);
  expect(await readdir(trash)).toHaveLength(1);
});

test("a v3 layout (Firefox) is kept at launch", async () => {
  const c = spacePaths(await tempFolder());
  const personal = '{"version":3,"widgets":[{"id":"meteo","x":0,"y":0,"l":500,"h":180}]}';
  await mkdir(c.accueil, { recursive: true });
  await writeFile(c.disposition, personal);
  await initSpace(c);
  expect(await readFile(c.disposition, "utf8")).toBe(personal);
  expect(existsSync(join(c.accueil, ".corbeille"))).toBe(false);
});

test("a deleted starter widget does not come back at the next launch", async () => {
  const c = spacePaths(await tempFolder());
  await initSpace(c);
  await rm(join(c.widgets, "meteo"), { recursive: true });
  await writeFile(c.disposition, '{"version":2,"widgets":[]}');
  await initSpace(c);
  expect(existsSync(join(c.widgets, "meteo"))).toBe(false);
  expect(await readFile(c.disposition, "utf8")).toBe('{"version":2,"widgets":[]}');
});

test("AGENTS.md, CLAUDE.md and the profile are recreated if missing", async () => {
  const c = spacePaths(await tempFolder());
  await initSpace(c);
  await rm(join(c.racine, "AGENTS.md"));
  await rm(join(c.profils, "claude.json"));
  await initSpace(c);
  expect(existsSync(join(c.racine, "AGENTS.md"))).toBe(true);
  expect(existsSync(join(c.profils, "claude.json"))).toBe(true);
});

test("two simultaneous initializations create each file only once", async () => {
  const c = spacePaths(await tempFolder());
  const [a, b] = await Promise.all([initSpace(c), initSpace(c)]);
  const all = [...a.crees, ...b.crees];
  expect(new Set(all).size).toBe(all.length);
  expect(all.length).toBe(expectedList.length);
});

test("a shipped AGENTS.md (its hash is known) is replaced by the current template", async () => {
  const c = spacePaths(await tempFolder());
  const model = await readFile(join(DEFAULT_MODELS, "AGENTS.md"), "utf8");
  const old = "ancien modèle\n";
  const h = sha256(old);
  OLD_AGENTS.add(h);
  try {
    await writeFile(join(c.racine, "AGENTS.md"), old);
    await initSpace(c);
    expect(await readFile(join(c.racine, "AGENTS.md"), "utf8")).toBe(model);
  } finally {
    OLD_AGENTS.delete(h);
  }
});

test("an AGENTS.md edited by the user is kept", async () => {
  const c = spacePaths(await tempFolder());
  const edited = "# Mes règles\nrien d'autre\n";
  await writeFile(join(c.racine, "AGENTS.md"), edited);
  await initSpace(c);
  expect(await readFile(join(c.racine, "AGENTS.md"), "utf8")).toBe(edited);
});

test("the AGENTS.md template is pinned: before editing it, add this hash to ANCIENS_AGENTS, then update the pin", async () => {
  expect(sha256(await readFile(join(import.meta.dirname, "..", "..", "modeles", "AGENTS.md")))).toBe(
    "1adea27921eb609aca3b73c58b690fe912c78a3eeba08a4c930f400862b6be36",
  );
});

test("the hash of every shipped version is kept: the list only grows", () => {
  expect(OLD_AGENTS.size).toBeGreaterThanOrEqual(36);
  expect(OLD_AGENTS.has("eaf40a1f51b1e62226e5087c7d7a73cf8b48b84e1e4fb214e89a119d0eb71d96")).toBe(true);
});

test("the AGENTS.md template describes the design mode remarks of site apps", async () => {
  const text = await readFile(join(DEFAULT_MODELS, "AGENTS.md"), "utf8");
  for (const pattern of ["Remarques du mode design", "/workspace/.webaios/remarques/site-<id>/", "MutationObserver", "site-tiers", "accueil/"]) {
    expect(text, pattern).toContain(pattern);
  }
});

test("the site.json examples given in AGENTS.md (YouTube, Vidola) are valid for the site app schema", async () => {
  const text = await readFile(join(DEFAULT_MODELS, "AGENTS.md"), "utf8");
  const blocks = [...text.matchAll(/```json site\.json:([a-z]+)\n([\s\S]*?)```/g)].map((m) => ({ nom: m[1]!, json: m[2]! }));
  expect(blocks.map((b) => b.nom).sort()).toEqual(["vidola", "youtube"]);
  for (const { nom: name, json } of blocks) {
    const r = DeclarationSite.safeParse(JSON.parse(json));
    expect(r.success, `${name} : ${r.success ? "" : r.error.message}`).toBe(true);
    if (!r.success) continue;
    expect(checkSiteDeclaration(r.data, { adressesLocales: false }), name).toBeNull();
    // Each declared tweak file is shown in AGENTS.md.
    for (const r2 of r.data.retouches) for (const f of [...r2.js, ...r2.css]) expect(text, `${name} : retouches/${f}`).toContain(`retouches/${f}`);
  }
});

test("the references given as examples in AGENTS.md are valid for the plan reader", async () => {
  const text = await readFile(join(DEFAULT_MODELS, "AGENTS.md"), "utf8");
  const blocks = [...text.matchAll(/```reference\n([\s\S]*?)```/g)].map((m) => m[1]!);
  expect(blocks.length).toBeGreaterThan(0);
  const references = blocks.flatMap((b) => b.split("\n").filter((l) => l.trim() !== ""));
  expect(references.length).toBeGreaterThanOrEqual(3);
  for (const r of references) {
    expect(readReference(r), r).not.toHaveProperty("erreur");
  }
});

// ——— Switching the starter widgets to workflows ———

const SHIPPED = join(import.meta.dirname, "shipped-harvests");

/** A space whose widget `id` stayed at an old shipped version (recolte.mjs, no workflow). */
async function spaceWithOldHarvest(id: string, harvest: string) {
  const c = spacePaths(await tempFolder());
  await initSpace(c);
  for (const f of START_CODE(id)) await rm(join(c.widgets, id, f));
  await writeFile(join(c.widgets, id, "recolte.mjs"), harvest);
  return c;
}

test("the 7 shipped versions of recolte.mjs have the known hashes", async () => {
  const files = (await readdir(SHIPPED)).sort();
  expect(files).toHaveLength(7);
  const hashes: Record<string, string[]> = {};
  for (const f of files) {
    const id = f.replace(/-[0-9a-f]{7}\.mjs$/, "");
    (hashes[id] ??= []).push(createHash("sha256").update(await readFile(join(SHIPPED, f))).digest("hex"));
  }
  for (const [id, list] of Object.entries(hashes)) {
    expect([...HARVESTS_SHIPPED[id as keyof typeof HARVESTS_SHIPPED]].sort(), id).toEqual(list.sort());
  }
  expect(Object.keys(hashes).sort()).toEqual(["actus-tech", "daily-dev", "meteo"]);
});

for (const file of readdirSync(join(import.meta.dirname, "shipped-harvests")).sort()) {
  const id = file.replace(/-[0-9a-f]{7}\.mjs$/, "");
  test(`an unmodified starter widget becomes a workflow, its recolte.mjs goes to the trash (${file})`, async () => {
    const old = await readFile(join(SHIPPED, file), "utf8");
    const c = await spaceWithOldHarvest(id, old);
    // What the user sees and sets is never touched.
    await writeFile(join(c.widgets, id, "widget.json"), '{"nom":"le mien"}');
    await writeFile(join(c.widgets, id, "affichage.html"), "<p>le mien</p>");
    const { crees } = await initSpace(c);

    expect(existsSync(join(c.widgets, id, "recolte.mjs"))).toBe(false);
    for (const f of START_CODE(id)) {
      expect(await readFile(join(c.widgets, id, f), "utf8"), f).toBe(await readFile(join(DEFAULT_MODELS, "widgets", id, f), "utf8"));
      expect(crees).toContain(join(c.widgets, id, f));
    }
    expect(await readFile(join(c.widgets, id, "widget.json"), "utf8")).toBe('{"nom":"le mien"}');
    expect(await readFile(join(c.widgets, id, "affichage.html"), "utf8")).toBe("<p>le mien</p>");
    const trash = await readdir(join(c.accueil, ".corbeille"));
    expect(trash).toHaveLength(1);
    expect(trash[0]).toMatch(new RegExp(`^${id}-recolte-\\d{4}-\\d\\d-\\d\\dT[^:]+\\.mjs$`));
    expect(await readFile(join(c.accueil, ".corbeille", trash[0]!), "utf8")).toBe(old);
    // The other starter widgets did not move, and a second launch does nothing anymore.
    expect((await initSpace(c)).crees).toEqual([]);
    expect(await readdir(join(c.accueil, ".corbeille"))).toHaveLength(1);
  });
}

test("a modified starter widget is left alone", async () => {
  const old = await readFile(join(SHIPPED, "actus-tech-4d4c5f1.mjs"), "utf8");
  const modified = old.replace("const GARDER = 15;", "const GARDER = 20;");
  expect(modified).not.toBe(old);
  const c = await spaceWithOldHarvest("actus-tech", modified);
  await initSpace(c);
  expect(await readFile(join(c.widgets, "actus-tech", "recolte.mjs"), "utf8")).toBe(modified);
  for (const f of START_CODE("actus-tech")) expect(existsSync(join(c.widgets, "actus-tech", f)), f).toBe(false);
  expect(existsSync(join(c.accueil, ".corbeille"))).toBe(false);
});

test("a starter widget that already has its workflow.json, or its own .mjs of the same name, is left alone", async () => {
  const old = await readFile(join(SHIPPED, "meteo-4d4c5f1.mjs"), "utf8");
  const c = await spaceWithOldHarvest("meteo", old);
  await writeFile(join(c.widgets, "meteo", "workflow.json"), '{"version":1,"blocs":[],"liens":[]}');
  await initSpace(c);
  expect(await readFile(join(c.widgets, "meteo", "recolte.mjs"), "utf8")).toBe(old);
  expect(await readFile(join(c.widgets, "meteo", "workflow.json"), "utf8")).toBe('{"version":1,"blocs":[],"liens":[]}');
  expect(existsSync(join(c.widgets, "meteo", "prevision.mjs"))).toBe(false);

  const d = await spaceWithOldHarvest("daily-dev", await readFile(join(SHIPPED, "daily-dev-4d4c5f1.mjs"), "utf8"));
  await writeFile(join(d.widgets, "daily-dev", "liens.mjs"), "export default () => [];");
  await initSpace(d);
  expect(existsSync(join(d.widgets, "daily-dev", "recolte.mjs"))).toBe(true);
  expect(existsSync(join(d.widgets, "daily-dev", "workflow.json"))).toBe(false);
  expect(existsSync(join(d.widgets, "daily-dev", "articles.mjs"))).toBe(false);
  expect(await readFile(join(d.widgets, "daily-dev", "liens.mjs"), "utf8")).toBe("export default () => [];");
  expect(existsSync(join(d.accueil, ".corbeille"))).toBe(false);
});

test("an interrupted switch (template workflow.json already there, shipped recolte.mjs left) puts recolte.mjs away", async () => {
  const old = await readFile(join(SHIPPED, "daily-dev-4d4c5f1.mjs"), "utf8");
  const c = spacePaths(await tempFolder());
  await initSpace(c);
  // The template's code and workflow.json copied, recolte.mjs not yet put away.
  await writeFile(join(c.widgets, "daily-dev", "recolte.mjs"), old);
  const { crees } = await initSpace(c);
  expect(crees).toEqual([]);
  expect(existsSync(join(c.widgets, "daily-dev", "recolte.mjs"))).toBe(false);
  const trash = await readdir(join(c.accueil, ".corbeille"));
  expect(trash).toHaveLength(1);
  expect(trash[0]).toMatch(/^daily-dev-recolte-/);
  expect(await readFile(join(c.accueil, ".corbeille", trash[0]!), "utf8")).toBe(old);
  for (const f of START_CODE("daily-dev")) {
    expect(await readFile(join(c.widgets, "daily-dev", f), "utf8"), f).toBe(await readFile(join(DEFAULT_MODELS, "widgets", "daily-dev", f), "utf8"));
  }
});

test("an agent widget (gmail) is left alone, even with a shipped recolte.mjs", async () => {
  const c = spacePaths(await tempFolder());
  await initSpace(c);
  const gmail = join(c.widgets, "gmail");
  await mkdir(gmail);
  const files = {
    "widget.json": '{"nom":"Gmail","sources":{"compte":["mail.google.com"],"publiques":[]}}',
    "recolte.mjs": "export default async (webaios) => ({ messages: [] });",
    "affichage.html": "<p>gmail</p>",
  };
  for (const [f, content] of Object.entries(files)) await writeFile(join(gmail, f), content);
  // Even an exact copy of a shipped harvest, outside a starter folder, stays where it is.
  const copy = join(c.widgets, "meteo-bis");
  await mkdir(copy);
  await writeFile(join(copy, "recolte.mjs"), await readFile(join(SHIPPED, "meteo-4d4c5f1.mjs")));
  await initSpace(c);
  expect((await readdir(gmail)).sort()).toEqual(Object.keys(files).sort());
  for (const [f, content] of Object.entries(files)) expect(await readFile(join(gmail, f), "utf8")).toBe(content);
  expect(await readdir(copy)).toEqual(["recolte.mjs"]);
  expect(existsSync(join(c.accueil, ".corbeille"))).toBe(false);
});

test("a shipped recolte.mjs that is a symbolic link is not followed", async () => {
  const c = await spaceWithOldHarvest("meteo", "");
  await rm(join(c.widgets, "meteo", "recolte.mjs"));
  const outside = join(await tempFolder(), "recolte.mjs");
  await writeFile(outside, await readFile(join(SHIPPED, "meteo-4d4c5f1.mjs")));
  await symlink(outside, join(c.widgets, "meteo", "recolte.mjs"));
  await initSpace(c);
  expect(existsSync(join(c.widgets, "meteo", "workflow.json"))).toBe(false);
  expect((await lstat(join(c.widgets, "meteo", "recolte.mjs"))).isSymbolicLink()).toBe(true);
  expect(existsSync(outside)).toBe(true);
});

test("a failed switch does not block the launch: the other widgets go through, the failed one retries at the next", async () => {
  const models = join(await tempFolder(), "modeles");
  await cp(DEFAULT_MODELS, models, { recursive: true });
  const c = await spaceWithOldHarvest("meteo", await readFile(join(SHIPPED, "meteo-4d4c5f1.mjs"), "utf8"));
  for (const f of START_CODE("actus-tech")) await rm(join(c.widgets, "actus-tech", f));
  await writeFile(join(c.widgets, "actus-tech", "recolte.mjs"), await readFile(join(SHIPPED, "actus-tech-4d4c5f1.mjs")));
  for (const f of START_CODE("daily-dev")) await rm(join(c.widgets, "daily-dev", f));
  await writeFile(join(c.widgets, "daily-dev", "recolte.mjs"), await readFile(join(SHIPPED, "daily-dev-4d4c5f1.mjs")));
  // daily-dev absent from the templates, and a meteo copy that fails (unreadable file).
  await rm(join(models, "widgets", "daily-dev"), { recursive: true });
  await chmod(join(models, "widgets", "meteo", "prevision.mjs"), 0o000);
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  let notes = 0;
  try {
    await expect(initSpace(c, models)).resolves.toBeDefined();
    notes = error.mock.calls.length;
  } finally {
    error.mockRestore();
    await chmod(join(models, "widgets", "meteo", "prevision.mjs"), 0o644);
  }
  expect(existsSync(join(c.widgets, "actus-tech", "workflow.json"))).toBe(true);
  expect(existsSync(join(c.widgets, "actus-tech", "recolte.mjs"))).toBe(false);
  expect(existsSync(join(c.widgets, "daily-dev", "recolte.mjs"))).toBe(true);
  expect(existsSync(join(c.widgets, "daily-dev", "workflow.json"))).toBe(false);
  expect(existsSync(join(c.widgets, "meteo", "recolte.mjs"))).toBe(true);
  expect(existsSync(join(c.widgets, "meteo", "workflow.json"))).toBe(false);
  expect(notes).toBe(1); // meteo; daily-dev, absent from the templates, is simply skipped

  // On the next launch, the meteo copy succeeds (the already-copied .mjs is identical to the template).
  await initSpace(c, models);
  expect(existsSync(join(c.widgets, "meteo", "workflow.json"))).toBe(true);
  expect(existsSync(join(c.widgets, "meteo", "recolte.mjs"))).toBe(false);
});

test("a new space gets the workflows", async () => {
  const c = spacePaths(await tempFolder());
  await initSpace(c);
  for (const [id, files] of Object.entries(START_FILES)) {
    expect((await readdir(join(c.widgets, id))).sort(), id).toEqual([...files].sort());
  }
  expect(existsSync(join(c.accueil, ".corbeille"))).toBe(false);
});

// ——— Migration of the displays shipped before Firefox ———

const DISPLAYS = join(import.meta.dirname, "shipped-displays");

test("the 9 shipped versions of affichage.html have the known hashes", async () => {
  const files = (await readdir(DISPLAYS)).sort();
  expect(files).toHaveLength(9);
  const hashes: Record<string, string[]> = {};
  for (const f of files) {
    const id = f.replace(/-[0-9a-f]{7}\.html$/, "");
    (hashes[id] ??= []).push(sha256(await readFile(join(DISPLAYS, f))));
  }
  for (const [id, list] of Object.entries(hashes)) {
    expect([...DISPLAYS_SHIPPED[id as keyof typeof DISPLAYS_SHIPPED]].sort(), id).toEqual(list.sort());
  }
  expect(Object.keys(hashes).sort()).toEqual(["actus-tech", "daily-dev", "meteo"]);
});

for (const file of readdirSync(DISPLAYS).sort()) {
  const id = file.replace(/-[0-9a-f]{7}\.html$/, "");
  test(`a starter display left at a shipped version is replaced by the template (${file})`, async () => {
    const old = await readFile(join(DISPLAYS, file), "utf8");
    const c = spacePaths(await tempFolder());
    await initSpace(c);
    await writeFile(join(c.widgets, id, "affichage.html"), old);
    const { crees } = await initSpace(c);
    expect(await readFile(join(c.widgets, id, "affichage.html"), "utf8")).toBe(
      await readFile(join(DEFAULT_MODELS, "widgets", id, "affichage.html"), "utf8"),
    );
    expect(crees).toContain(join(c.widgets, id, "affichage.html"));
    // A second launch does nothing anymore.
    expect((await initSpace(c)).crees).toEqual([]);
  });
}

test("a starter display modified by the user is left alone", async () => {
  const old = await readFile(join(DISPLAYS, "meteo-4d4c5f1.html"), "utf8");
  const modified = `${old}\n<!-- le mien -->`;
  const c = spacePaths(await tempFolder());
  await initSpace(c);
  await writeFile(join(c.widgets, "meteo", "affichage.html"), modified);
  const { crees } = await initSpace(c);
  expect(await readFile(join(c.widgets, "meteo", "affichage.html"), "utf8")).toBe(modified);
  expect(crees).toEqual([]);
});
