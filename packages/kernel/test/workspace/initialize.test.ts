import { expect, test } from "vitest";
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spacePaths } from "../../src/paths.js";
import { initSpace, DEFAULT_TEMPLATES, DISPLAYS_SHIPPED, OLD_AGENTS, OLD_CLAUDE_MD, OLD_EXTENSIONS_GUIDE, OLD_TEMPLATES } from "../../src/workspace/initialize.js";
import { createHash } from "node:crypto";
import { DeclarationWidget } from "../../src/home/schemas.js";
import { DeclarationSite, checkSiteDeclaration } from "../../src/sites/schemas.js";
import { readReference } from "../../src/pages/plan.js";
import { tempFolder } from "../helpers/temp.js";

const sha256 = (content: string | Buffer) => createHash("sha256").update(content).digest("hex");
const FR = join(DEFAULT_TEMPLATES, "fr");
const EN = join(DEFAULT_TEMPLATES, "en");

/** The starter widgets' files in a new space: workflows, without harvest.mjs. */
const START_FILES: Record<string, string[]> = {
  meteo: ["widget.json", "example.json", "display.html", "workflow.json", "ville.mjs", "prevision.mjs"],
  "actus-tech": ["widget.json", "example.json", "display.html", "workflow.json", "articles.mjs"],
  "daily-dev": ["widget.json", "example.json", "display.html", "workflow.json", "liens.mjs", "articles.mjs"],
};

const expectedList = [
  "AGENTS.md",
  "CLAUDE.md",
  "guides/widgets.md",
  "guides/actions.md",
  "guides/site-apps.md",
  ...Object.entries(START_FILES).flatMap(([w, files]) => files.map((f) => `home/widgets/${w}/${f}`)),
];

test("creates the full space in an empty folder", async () => {
  const c = spacePaths(await tempFolder());
  const { created: crees } = await initSpace(c);
  for (const f of expectedList) expect(existsSync(join(c.root, f)), f).toBe(true);
  expect(existsSync(c.projects)).toBe(true);
  expect(existsSync(c.logs)).toBe(true);
  expect(existsSync(c.actions)).toBe(true);
  expect(existsSync(c.sites)).toBe(true);
  expect(existsSync(c.components)).toBe(true);
  expect(crees.length).toBe(expectedList.length);
});

test(".ressac swapped for a link, or a link at its top, is made a real folder again; the targets are untouched", async () => {
  const c = spacePaths(await tempFolder());
  const outside = await tempFolder();
  await writeFile(join(outside, "secret"), "1");
  await mkdir(c.root, { recursive: true });
  await symlink(outside, c.internal);
  await initSpace(c);
  expect(lstatSync(c.internal).isDirectory()).toBe(true);
  await symlink(outside, join(c.internal, "harvests"));
  await initSpace(c);
  expect(existsSync(join(c.internal, "harvests"))).toBe(false);
  expect(readdirSync(outside)).toEqual(["secret"]);
});

test("the widgets and actions guides give the caps of the harvest's copy, in each language", async () => {
  for (const [lang, caps] of [["en", "1 MB per file, 4 MB in all"], ["fr", "1 Mo par fichier"]] as const)
    for (const guide of ["widgets.md", "actions.md"]) expect(await readFile(join(DEFAULT_TEMPLATES, lang, "guides", guide), "utf8")).toContain(caps);
});

test("never overwrites an existing file", async () => {
  const c = spacePaths(await tempFolder());
  await writeFile(join(c.root, "AGENTS.md"), "perso");
  const { created: crees } = await initSpace(c);
  expect(await readFile(join(c.root, "AGENTS.md"), "utf8")).toBe("perso");
  expect(crees).not.toContain(join(c.root, "AGENTS.md"));
});

test("idempotent: a second call creates nothing", async () => {
  const c = spacePaths(await tempFolder());
  await initSpace(c);
  expect((await initSpace(c)).created).toEqual([]);
});

test("AGENTS.md mentions the required elements", async () => {
  const c = spacePaths(await tempFolder());
  await initSpace(c);
  const text = await readFile(join(c.root, "AGENTS.md"), "utf8");
  for (const m of ["current_page", "open_tab", "5280", "5299", "0.0.0.0", "/workspace/projects", "show_recap"]) {
    expect(text, m).toContain(m);
  }
  expect(await readFile(join(c.root, "guides", "widgets.md"), "utf8")).toContain("state.json");
});

test("AGENTS.md stays short and every guide it names ships in each language", async () => {
  for (const dir of [FR, EN]) {
    const text = await readFile(join(dir, "AGENTS.md"), "utf8");
    // Loaded whole at every session: a local model's window must keep room for the work.
    expect(text.length, dir).toBeLessThan(30_000);
    const named = [...new Set(text.match(/\/workspace\/guides\/[a-z-]+\.md/g))];
    expect(named.length, dir).toBe(3);
    for (const g of named) expect(existsSync(join(dir, g.slice("/workspace/".length))), g).toBe(true);
  }
});

test("a new space gets the three starter widgets and no layout file", async () => {
  const c = spacePaths(await tempFolder());
  await initSpace(c, "fr");
  expect((await readdir(c.widgets)).sort()).toEqual(["actus-tech", "daily-dev", "meteo"]);
  expect(existsSync(c.layout)).toBe(false);
  for (const id of ["meteo", "actus-tech", "daily-dev"]) {
    const d = DeclarationWidget.parse(JSON.parse(await readFile(join(c.widgets, id, "widget.json"), "utf8")));
    JSON.parse(await readFile(join(c.widgets, id, "example.json"), "utf8"));
    if (id !== "meteo") expect(JSON.stringify(d.config)).toContain("sécurité informatique");
  }
  const daily = DeclarationWidget.parse(JSON.parse(await readFile(join(c.widgets, "daily-dev", "widget.json"), "utf8")));
  expect(daily.sources.account).toEqual(["app.daily.dev"]);
});

test("a v3 layout (Firefox) is kept at launch", async () => {
  const c = spacePaths(await tempFolder());
  const personal = '{"version":3,"widgets":[{"id":"meteo","x":0,"y":0,"w":500,"h":180}]}';
  await mkdir(c.home, { recursive: true });
  await writeFile(c.layout, personal);
  await initSpace(c);
  expect(await readFile(c.layout, "utf8")).toBe(personal);
  expect(existsSync(join(c.home, ".trash"))).toBe(false);
});

test("a deleted starter widget does not come back at the next launch", async () => {
  const c = spacePaths(await tempFolder());
  await initSpace(c);
  await rm(join(c.widgets, "meteo"), { recursive: true });
  await initSpace(c);
  expect(existsSync(join(c.widgets, "meteo"))).toBe(false);
});

test("AGENTS.md is recreated if missing", async () => {
  const c = spacePaths(await tempFolder());
  await initSpace(c);
  await rm(join(c.root, "AGENTS.md"));
  await initSpace(c);
  expect(existsSync(join(c.root, "AGENTS.md"))).toBe(true);
});

test("two simultaneous initializations create each file only once", async () => {
  const c = spacePaths(await tempFolder());
  const [a, b] = await Promise.all([initSpace(c), initSpace(c)]);
  const all = [...a.created, ...b.created];
  expect(new Set(all).size).toBe(all.length);
  expect(all.length).toBe(expectedList.length);
});

test("a shipped AGENTS.md (its hash is known) is replaced by the current template", async () => {
  const c = spacePaths(await tempFolder());
  const model = await readFile(join(EN, "AGENTS.md"), "utf8");
  const old = "ancien modèle\n";
  const h = sha256(old);
  OLD_AGENTS.add(h);
  try {
    await writeFile(join(c.root, "AGENTS.md"), old);
    await initSpace(c);
    expect(await readFile(join(c.root, "AGENTS.md"), "utf8")).toBe(model);
  } finally {
    OLD_AGENTS.delete(h);
  }
});

test("an AGENTS.md edited by the user is kept", async () => {
  const c = spacePaths(await tempFolder());
  const edited = "# Mes règles\nrien d'autre\n";
  await writeFile(join(c.root, "AGENTS.md"), edited);
  await initSpace(c);
  expect(await readFile(join(c.root, "AGENTS.md"), "utf8")).toBe(edited);
});

test("CLAUDE.md is rewritten only when identical to an old template", async () => {
  const c = spacePaths(await tempFolder());
  const oldClaude = "Lis l'ancien AGENTS.md.\n";
  const added = sha256(oldClaude);
  (OLD_CLAUDE_MD as Set<string>).add(added);
  try {
    await writeFile(join(c.root, "CLAUDE.md"), oldClaude);
    await initSpace(c, "fr");
    expect(await readFile(join(c.root, "CLAUDE.md"), "utf8")).toBe(await readFile(join(FR, "CLAUDE.md"), "utf8"));
    // edited by the user: kept
    await writeFile(join(c.root, "CLAUDE.md"), "Mes règles.\n");
    await initSpace(c, "en");
    expect(await readFile(join(c.root, "CLAUDE.md"), "utf8")).toBe("Mes règles.\n");
  } finally {
    (OLD_CLAUDE_MD as Set<string>).delete(added);
  }
});

test("initSpace no longer puts browsing-notes.md in the workspace (the kernel keeps it in .ressac)", async () => {
  const c = spacePaths(await tempFolder());
  await initSpace(c);
  expect(existsSync(join(c.root, "browsing-notes.md"))).toBe(false);
});

test("an old shipped browsing-notes.md is deleted, an edited one is kept", async () => {
  // The texts shipped until 0.1.13: fr, en.
  for (const old of ["# Carnet de recherche\n\nLeçons générales de l'agent sur la recherche web : comment reconnaître une situation où il s'est perdu, et que faire la prochaine fois.\nVous pouvez le lire et le modifier ; il n'est jamais remplacé ni effacé par Ressac, et rien n'y est noté d'une vérification ni de ce que vous tapez.\n", "# Browsing notes\n\nThe agent's general lessons about web search: how to recognise a situation where it got lost, and what to do next time.\nYou can read and edit it; Ressac never replaces or erases it, and nothing is noted in it about a verification or about what you type.\n"]) {
    const c = spacePaths(await tempFolder());
    const notes = join(c.root, "browsing-notes.md");
    await writeFile(notes, old);
    await initSpace(c);
    expect(existsSync(notes), old).toBe(false);
  }
  const c = spacePaths(await tempFolder());
  await writeFile(join(c.root, "browsing-notes.md"), "my lessons\n");
  await initSpace(c);
  expect(await readFile(join(c.root, "browsing-notes.md"), "utf8")).toBe("my lessons\n");
});

test("the removed extensions guide goes while untouched, an edited one is kept", async () => {
  const c = spacePaths(await tempFolder());
  const guide = join(c.root, "guides", "extensions.md");
  await initSpace(c);
  expect(existsSync(guide)).toBe(false);
  // The 0.1.26 copies (fr, en) are known shipped versions.
  expect(OLD_EXTENSIONS_GUIDE.has("d4ef40587ed42fab3395c5188d95d48175dca97eeba231095e412c028f5b1b23")).toBe(true);
  expect(OLD_EXTENSIONS_GUIDE.has("c1c07f72de27a742c2b20908921c0bc3a790485e30a4e6abd1270ba6798a76af")).toBe(true);
  const shipped = "a shipped guide\n";
  OLD_EXTENSIONS_GUIDE.add(sha256(shipped));
  try {
    await mkdir(join(c.root, "guides"), { recursive: true });
    await writeFile(guide, shipped);
    await initSpace(c);
    expect(existsSync(guide)).toBe(false);
  } finally {
    OLD_EXTENSIONS_GUIDE.delete(sha256(shipped));
  }
  await writeFile(guide, "my notes\n");
  await initSpace(c);
  expect(await readFile(guide, "utf8")).toBe("my notes\n");
});

test("the CLAUDE.md and AGENTS.md shipped before the English formats are known old templates", () => {
  expect(OLD_CLAUDE_MD.has("11baa6aab5848a8fff974dabc5e78e9ccc69b8d2a53a91d23fa9a3f0ca73632b")).toBe(true);
  // the AGENTS.md shipped before the English formats
  expect(OLD_AGENTS.has("1adea27921eb609aca3b73c58b690fe912c78a3eeba08a4c930f400862b6be36")).toBe(true);
});

test("the AGENTS.md templates are pinned: before editing one, add its hash to OLD_AGENTS, then update the pin", async () => {
  expect(sha256(await readFile(join(FR, "AGENTS.md")))).toBe("792f4579ecf6f8d6c3df7518f009bae208f2704944a62b93b9f50de007c8682a");
  expect(sha256(await readFile(join(EN, "AGENTS.md")))).toBe("f30b7297791e0e4c4574b121636b89a5ab99ad62ea3cc60ae91ddd1265adb6a0");
  expect(OLD_AGENTS.has("db5bfd093244cfc14097afa5bc69ec85cd3076f922c118da1b362da5c85ada11")).toBe(true);
  expect(OLD_AGENTS.has("e078a5edca645e49e1f1021a3114feaff533ed9669124cedf1dd1bc232d41f58")).toBe(true);
  expect(OLD_AGENTS.has("7b028830acee8f891d9258b5b3f5aab9a8934bd50537b70c0508fa27bee4c2eb")).toBe(true);
  expect(OLD_AGENTS.has("f9807f7224851e6bc752fff45cd70a22512f9ad462a9a7564963583d5ebc3527")).toBe(true);
  expect(OLD_AGENTS.has("2efd3c8aa133558c7855b6877ced708b8740062bb6e589cde32507d6d308c459")).toBe(true);
  expect(OLD_AGENTS.has("ad517ef63b2ed4f0ea6acf49fdd81579d83168022e96b0838af07beb8bc094e2")).toBe(true);
  expect(OLD_AGENTS.has("2c2667b528edf83b2eb01334e3f9b22557480db6fbfdaf49a438f23520c28097")).toBe(true);
  expect(OLD_AGENTS.has("5600b474da619c8ef707d20082156cdff61cf22e9929ffdddae09ee78ef04819")).toBe(true);
  expect(OLD_AGENTS.has("6ecc3a5571398b8490f4b384b32c191e56111e3eebe092e1ccf03790f2ec845b")).toBe(true);
  expect(OLD_AGENTS.has("ff0f49e00a04cec590ee023394221e8bbf28dd0439a628e48ea307acaffa0a8e")).toBe(true);
  expect(OLD_AGENTS.has("08de4118ce41e65b76e8b9795595d41e749c9b60d72a4f3f87691d2cbc99e8ab")).toBe(true);
  expect(OLD_AGENTS.has("58be09d0c5a9d6b8a08f055fd4ed62415403b54f0acd4f6596e0473a4b6da875")).toBe(true);
});

test("an untouched AGENTS.md of the previous release is replaced", async () => {
  // The texts from before the three tiers (no lab, the notebook in every mode): fr, en.
  const previous = {
    "AGENTS.md": ["3c746be1d8f398077a604ce4113ab33e4c62b5723aea9d03fbd090b80f597e1b", "ec25157a83303e77861b9a4c349314fd2db357018b7492c906ffe9b41a28b268"],
    "guides/actions.md": ["54c4288f8b97886603cb5bc76cd4debb5c03ca5664c132356b089343638d59bd", "b652662ff8149b0f8114b38d84c9504d29e39dd54a53b53ee4f7e7363bdd7d9e"],
    "guides/site-apps.md": ["23fcb3a1165577e19e64c450280e9c85eb11ecef75ffcff9dec70a310889c62d", "ef0f563ffe2bb92d4d3a6b0b6bc17d5f48422777ae83e22b907b420e7ce7de6e"],
    "guides/widgets.md": ["499ac89ddc5b67c4da335c206f88ae9b97122416f0f87e0197e7695d13d66d13", "a502baba514f31a4bba9711a17dd13941e6c634e8f7d9014a0cca59d43a11f60"],
  };
  for (const [rel, hashes] of Object.entries(previous))
    for (const h of hashes) {
      expect(OLD_TEMPLATES[rel]?.has(h), `${rel} ${h}`).toBe(true);
      for (const dir of [FR, EN]) expect(sha256(await readFile(join(dir, rel))), rel).not.toBe(h);
    }
  // A copy left at one of them is swapped for the current template.
  const c = spacePaths(await tempFolder());
  await initSpace(c, "fr");
  const shipped = "le texte d'avant les niveaux\n";
  OLD_AGENTS.add(sha256(shipped));
  try {
    await writeFile(join(c.root, "AGENTS.md"), shipped);
    await initSpace(c, "fr");
    expect(await readFile(join(c.root, "AGENTS.md"), "utf8")).toBe(await readFile(join(FR, "AGENTS.md"), "utf8"));
  } finally {
    OLD_AGENTS.delete(sha256(shipped));
  }
});

test("the hash of every shipped version is kept: the list only grows", () => {
  expect(OLD_AGENTS.size).toBeGreaterThanOrEqual(38);
  expect(OLD_AGENTS.has("eaf40a1f51b1e62226e5087c7d7a73cf8b48b84e1e4fb214e89a119d0eb71d96")).toBe(true);
});

for (const [lang, heading] of [["fr", "Remarques du mode design"], ["en", "Design mode remarks"]] as const) {
  test(`the site apps guide describes the design mode remarks of site apps (${lang})`, async () => {
    const text = await readFile(join(DEFAULT_TEMPLATES, lang, "guides", "site-apps.md"), "utf8");
    for (const pattern of [heading, "/workspace/.ressac/remarks/site-<id>/", "MutationObserver", "third-party-site", "home/"]) {
      expect(text, pattern).toContain(pattern);
    }
  });

  test(`the site.json examples given in the site apps guide (YouTube, Vidola) are valid for the site app schema (${lang})`, async () => {
    const text = await readFile(join(DEFAULT_TEMPLATES, lang, "guides", "site-apps.md"), "utf8");
    const blocks = [...text.matchAll(/```json site\.json:([a-z]+)\n([\s\S]*?)```/g)].map((m) => ({ name: m[1]!, json: m[2]! }));
    expect(blocks.map((b) => b.name).sort()).toEqual(["vidola", "youtube"]);
    for (const { name, json } of blocks) {
      const r = DeclarationSite.safeParse(JSON.parse(json));
      expect(r.success, `${name} : ${r.success ? "" : r.error.message}`).toBe(true);
      if (!r.success) continue;
      expect(checkSiteDeclaration(r.data, { localAddresses: false }), name).toBeNull();
      // Each declared tweak file is shown in the guide.
      for (const r2 of r.data.tweaks) for (const f of [...r2.js, ...r2.css]) expect(text, `${name} : retouches/${f}`).toContain(`tweaks/${f}`);
    }
  });

  test(`the references given as examples in AGENTS.md are valid for the plan reader (${lang})`, async () => {
    const text = await readFile(join(DEFAULT_TEMPLATES, lang, "AGENTS.md"), "utf8");
    const blocks = [...text.matchAll(/```reference\n([\s\S]*?)```/g)].map((m) => m[1]!);
    expect(blocks.length).toBeGreaterThan(0);
    const references = blocks.flatMap((b) => b.split("\n").filter((l) => l.trim() !== ""));
    expect(references.length).toBeGreaterThanOrEqual(3);
    for (const r of references) {
      expect(readReference(r), r).not.toHaveProperty("error");
    }
  });
}

test("a new space gets the workflows", async () => {
  const c = spacePaths(await tempFolder());
  await initSpace(c);
  for (const [id, files] of Object.entries(START_FILES)) {
    expect((await readdir(join(c.widgets, id))).sort(), id).toEqual([...files].sort());
  }
  expect(existsSync(join(c.home, ".trash"))).toBe(false);
});

// ——— Update of the starter displays left as shipped ———

const DISPLAYS = join(import.meta.dirname, "shipped-displays");

test("the 17 shipped versions of display.html have the known hashes", async () => {
  const files = (await readdir(DISPLAYS)).sort();
  expect(files).toHaveLength(17);
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
    await initSpace(c, "fr");
    await writeFile(join(c.widgets, id, "display.html"), old);
    const { created: crees } = await initSpace(c, "fr");
    expect(await readFile(join(c.widgets, id, "display.html"), "utf8")).toBe(
      await readFile(join(FR, "widgets", id, "display.html"), "utf8"),
    );
    // The copy of the current template is already up to date: nothing to replace.
    if (old !== (await readFile(join(FR, "widgets", id, "display.html"), "utf8"))) expect(crees).toContain(join(c.widgets, id, "display.html"));
    // A second launch does nothing anymore.
    expect((await initSpace(c, "fr")).created).toEqual([]);
  });
}

test("a starter display modified by the user is left alone", async () => {
  const old = await readFile(join(DISPLAYS, "meteo-4d4c5f1.html"), "utf8");
  const modified = `${old}\n<!-- le mien -->`;
  const c = spacePaths(await tempFolder());
  await initSpace(c, "fr");
  await writeFile(join(c.widgets, "meteo", "display.html"), modified);
  const { created: crees } = await initSpace(c, "fr");
  expect(await readFile(join(c.widgets, "meteo", "display.html"), "utf8")).toBe(modified);
  expect(crees).toEqual([]);
});

// ——— Templates per language and the swap on a language change ———

const WIDGETS = ["actus-tech", "daily-dev", "meteo"] as const;

async function expectWidgetsIn(c: ReturnType<typeof spacePaths>, models: string) {
  for (const [id, files] of Object.entries(START_FILES)) {
    for (const f of files) expect(await readFile(join(c.widgets, id, f), "utf8"), `${id}/${f}`).toBe(await readFile(join(models, "widgets", id, f), "utf8"));
  }
}

test("a new space in English gets the English AGENTS.md, CLAUDE.md, notes and widgets", async () => {
  const c = spacePaths(await tempFolder());
  await initSpace(c, "en");
  for (const f of ["AGENTS.md", "CLAUDE.md"]) expect(await readFile(join(c.root, f), "utf8"), f).toBe(await readFile(join(EN, f), "utf8"));
  expect(await readFile(join(c.root, "CLAUDE.md"), "utf8")).toBe("@AGENTS.md\n");
  await expectWidgetsIn(c, EN);
  const tech = DeclarationWidget.parse(JSON.parse(await readFile(join(c.widgets, "actus-tech", "widget.json"), "utf8")));
  expect(tech.sources.public).not.toContain("next.ink");
  expect(await readFile(join(c.widgets, "actus-tech", "workflow.json"), "utf8")).not.toContain("next.ink");
  for (const id of WIDGETS) {
    expect(await readFile(join(c.widgets, id, "display.html"), "utf8"), id).toContain('<html lang="en">');
    if (id !== "meteo") expect(await readFile(join(c.widgets, id, "workflow.json"), "utf8"), id).toContain("Summarize in English");
  }
});

test("an unknown language (de) gets the English templates", async () => {
  const c = spacePaths(await tempFolder());
  await initSpace(c, "de");
  expect(await readFile(join(c.root, "AGENTS.md"), "utf8")).toBe(await readFile(join(EN, "AGENTS.md"), "utf8"));
  await expectWidgetsIn(c, EN);
});

test("a path-like language never leaves the templates folder", async () => {
  const c = spacePaths(await tempFolder());
  await initSpace(c, "../templates/fr");
  expect(await readFile(join(c.root, "AGENTS.md"), "utf8")).toBe(await readFile(join(EN, "AGENTS.md"), "utf8"));
});

test("a French space left untouched switches to English: AGENTS.md, CLAUDE.md, notes, widgets; data files are kept", async () => {
  const c = spacePaths(await tempFolder());
  await initSpace(c, "fr");
  await writeFile(join(c.widgets, "meteo", "data.json"), '{"ville":"Bordeaux"}');
  const { created } = await initSpace(c, "en");
  for (const f of ["AGENTS.md", "CLAUDE.md"]) expect(await readFile(join(c.root, f), "utf8"), f).toBe(await readFile(join(EN, f), "utf8"));
  await expectWidgetsIn(c, EN);
  expect(await readFile(join(c.widgets, "meteo", "data.json"), "utf8")).toBe('{"ville":"Bordeaux"}');
  expect(created).toContain(join(c.root, "AGENTS.md"));
  expect((await initSpace(c, "en")).created).toEqual([]);
  // And back.
  await initSpace(c, "fr");
  expect(await readFile(join(c.root, "AGENTS.md"), "utf8")).toBe(await readFile(join(FR, "AGENTS.md"), "utf8"));
  await expectWidgetsIn(c, FR);
});

test("edited files stay in their language on a switch", async () => {
  const c = spacePaths(await tempFolder());
  await initSpace(c, "fr");
  const agents = (await readFile(join(c.root, "AGENTS.md"), "utf8")) + "\nMa règle.\n";
  await writeFile(join(c.root, "AGENTS.md"), agents);
  await initSpace(c, "en");
  expect(await readFile(join(c.root, "AGENTS.md"), "utf8")).toBe(agents);
  expect(await readFile(join(c.root, "CLAUDE.md"), "utf8")).toBe(await readFile(join(EN, "CLAUDE.md"), "utf8"));
});

test("an AGENTS.md left at an old shipped version goes to the language asked", async () => {
  const c = spacePaths(await tempFolder());
  // The AGENTS.md shipped before the English formats, recognised by its hash only: a stand-in with a known hash.
  const old = "ancien AGENTS\n";
  OLD_AGENTS.add(sha256(old));
  try {
    await writeFile(join(c.root, "AGENTS.md"), old);
    await initSpace(c, "en");
    expect(await readFile(join(c.root, "AGENTS.md"), "utf8")).toBe(await readFile(join(EN, "AGENTS.md"), "utf8"));
  } finally {
    OLD_AGENTS.delete(sha256(old));
  }
});

test("a widget with an edited display.html is kept whole on a switch; the others switch", async () => {
  const c = spacePaths(await tempFolder());
  await initSpace(c, "fr");
  const display = (await readFile(join(c.widgets, "meteo", "display.html"), "utf8")) + "<!-- mine -->";
  await writeFile(join(c.widgets, "meteo", "display.html"), display);
  await initSpace(c, "en");
  expect(await readFile(join(c.widgets, "meteo", "display.html"), "utf8")).toBe(display);
  for (const f of START_FILES.meteo!.filter((f) => f !== "display.html")) {
    expect(await readFile(join(c.widgets, "meteo", f), "utf8"), f).toBe(await readFile(join(FR, "widgets", "meteo", f), "utf8"));
  }
  expect(await readFile(join(c.widgets, "actus-tech", "widget.json"), "utf8")).toBe(await readFile(join(EN, "widgets", "actus-tech", "widget.json"), "utf8"));
});

test("a widget with an edited workflow.json is kept whole, its old shipped display included", async () => {
  const c = spacePaths(await tempFolder());
  await initSpace(c, "fr");
  await writeFile(join(c.widgets, "daily-dev", "workflow.json"), '{"version":1,"blocks":[],"links":[]}');
  await initSpace(c, "en");
  expect(await readFile(join(c.widgets, "daily-dev", "widget.json"), "utf8")).toBe(await readFile(join(FR, "widgets", "daily-dev", "widget.json"), "utf8"));
  expect(await readFile(join(c.widgets, "daily-dev", "display.html"), "utf8")).toBe(await readFile(join(FR, "widgets", "daily-dev", "display.html"), "utf8"));
});

test("a starter widget with a template file deleted is kept whole on a switch", async () => {
  const c = spacePaths(await tempFolder());
  await initSpace(c, "fr");
  await rm(join(c.widgets, "meteo", "example.json"));
  await initSpace(c, "en");
  expect(existsSync(join(c.widgets, "meteo", "example.json"))).toBe(false);
  for (const f of START_FILES.meteo!.filter((f) => f !== "example.json")) {
    expect(await readFile(join(c.widgets, "meteo", f), "utf8"), f).toBe(await readFile(join(FR, "widgets", "meteo", f), "utf8"));
  }
});

test("CLAUDE.md imports AGENTS.md (loaded at start, not left to the agent); the old pointer versions are replaced", async () => {
  for (const l of ["fr", "en"]) expect((await readFile(join(DEFAULT_TEMPLATES, l, "CLAUDE.md"), "utf8")).trim()).toBe("@AGENTS.md");
  expect(OLD_CLAUDE_MD.has("11baa6aab5848a8fff974dabc5e78e9ccc69b8d2a53a91d23fa9a3f0ca73632b")).toBe(true); // « Lis et applique /workspace/AGENTS.md. »
  expect(OLD_CLAUDE_MD.has("4690fb441d1ffb32d9e9915a8fc65545f25de774d368c48041e86de43d7a8cab")).toBe(true); // « Read and apply /workspace/AGENTS.md. »
});
