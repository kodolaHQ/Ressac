import { expect, test } from "vitest";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spacePaths } from "../../src/paths.js";
import { initSpace, DEFAULT_TEMPLATES, DISPLAYS_SHIPPED, OLD_AGENTS, OLD_AGENT_PROFILE, OLD_CLAUDE_MD } from "../../src/workspace/initialize.js";
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
  "browsing-notes.md",
  "guides/widgets.md",
  "guides/extensions.md",
  "guides/actions.md",
  "guides/site-apps.md",
  ...Object.entries(START_FILES).flatMap(([w, files]) => files.map((f) => `home/widgets/${w}/${f}`)),
  ".ressac/profiles/claude.json",
  ".ressac/profiles/codex.json",
];

test("creates the full space in an empty folder", async () => {
  const c = spacePaths(await tempFolder());
  const { created: crees } = await initSpace(c);
  for (const f of expectedList) expect(existsSync(join(c.root, f)), f).toBe(true);
  expect(existsSync(c.projects)).toBe(true);
  expect(existsSync(c.extensions)).toBe(true);
  expect(existsSync(c.actions)).toBe(true);
  expect(existsSync(c.sites)).toBe(true);
  expect(existsSync(c.components)).toBe(true);
  expect(crees.length).toBe(expectedList.length);
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
    expect(named.length, dir).toBe(4);
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

test("AGENTS.md, CLAUDE.md and the profile are recreated if missing", async () => {
  const c = spacePaths(await tempFolder());
  await initSpace(c);
  await rm(join(c.root, "AGENTS.md"));
  await rm(join(c.profiles, "claude.json"));
  await initSpace(c);
  expect(existsSync(join(c.root, "AGENTS.md"))).toBe(true);
  expect(existsSync(join(c.profiles, "claude.json"))).toBe(true);
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

test("CLAUDE.md and the agent profile are rewritten only when identical to an old template", async () => {
  const c = spacePaths(await tempFolder());
  const oldProfile = '{"id":"ancien"}\n';
  const oldClaude = "Lis l'ancien AGENTS.md.\n";
  const added = [sha256(oldProfile), sha256(oldClaude)];
  (OLD_AGENT_PROFILE as Set<string>).add(added[0]!);
  (OLD_CLAUDE_MD as Set<string>).add(added[1]!);
  try {
    await mkdir(c.profiles, { recursive: true });
    await writeFile(join(c.profiles, "claude.json"), oldProfile);
    await writeFile(join(c.root, "CLAUDE.md"), oldClaude);
    await initSpace(c, "fr");
    expect(await readFile(join(c.profiles, "claude.json"), "utf8")).toBe(await readFile(join(DEFAULT_TEMPLATES, "agent-profile.json"), "utf8"));
    expect(await readFile(join(c.root, "CLAUDE.md"), "utf8")).toBe(await readFile(join(FR, "CLAUDE.md"), "utf8"));
    // edited by the user: kept
    await writeFile(join(c.profiles, "claude.json"), '{"id":"claude","mine":true}');
    await writeFile(join(c.root, "CLAUDE.md"), "Mes règles.\n");
    await initSpace(c, "en");
    expect(await readFile(join(c.profiles, "claude.json"), "utf8")).toBe('{"id":"claude","mine":true}');
    expect(await readFile(join(c.root, "CLAUDE.md"), "utf8")).toBe("Mes règles.\n");
  } finally {
    (OLD_AGENT_PROFILE as Set<string>).delete(added[0]!);
    (OLD_CLAUDE_MD as Set<string>).delete(added[1]!);
  }
});

test("initSpace creates browsing-notes.md and never overwrites it", async () => {
  const c = spacePaths(await tempFolder());
  await initSpace(c);
  const notes = join(c.root, "browsing-notes.md");
  expect(existsSync(notes)).toBe(true);
  await writeFile(notes, "my lessons\n");
  await initSpace(c);
  expect(await readFile(notes, "utf8")).toBe("my lessons\n");
});

test("a profile left at the previous shipped version is replaced", async () => {
  expect(OLD_AGENT_PROFILE.has("4bedd62a30db9f408bd8ada622b5bc415cd7ac1fdcd7d9e1b52eda1bc1d2fc35")).toBe(true);
  const c = spacePaths(await tempFolder());
  await mkdir(c.profiles, { recursive: true });
  await writeFile(
    join(c.profiles, "claude.json"),
    '{\n  "id": "claude",\n  "name": "Claude Code",\n  "interactive": ["claude", "--dangerously-skip-permissions", "--mcp-config", "{mcpConfig}"],\n  "resume": ["claude", "--dangerously-skip-permissions", "--continue", "--mcp-config", "{mcpConfig}"],\n  "nonInteractive": ["claude", "--dangerously-skip-permissions", "-p", "{prompt}"],\n  "mcpConfig": "claude-json"\n}\n',
  );
  expect(sha256(await readFile(join(c.profiles, "claude.json")))).toBe("4bedd62a30db9f408bd8ada622b5bc415cd7ac1fdcd7d9e1b52eda1bc1d2fc35");
  await initSpace(c);
  expect(await readFile(join(c.profiles, "claude.json"), "utf8")).toBe(await readFile(join(DEFAULT_TEMPLATES, "agent-profile.json"), "utf8"));
});

test("the profile shipped before the English formats (profil-claude.json) is a known old template", () => {
  expect(OLD_AGENT_PROFILE.has("2e20e733cc7c9aa30c807e227a6547824afbfc1f6a8ffe0c005cc9f51c039085")).toBe(true);
  expect(OLD_CLAUDE_MD.has("11baa6aab5848a8fff974dabc5e78e9ccc69b8d2a53a91d23fa9a3f0ca73632b")).toBe(true);
  // the AGENTS.md shipped before the English formats
  expect(OLD_AGENTS.has("1adea27921eb609aca3b73c58b690fe912c78a3eeba08a4c930f400862b6be36")).toBe(true);
});

test("the AGENTS.md templates are pinned: before editing one, add its hash to OLD_AGENTS, then update the pin", async () => {
  expect(sha256(await readFile(join(FR, "AGENTS.md")))).toBe("68c45b6530e17813c57ed0adcabe36e6da5f85b0f4befcf29df008f326c4f45e");
  expect(sha256(await readFile(join(EN, "AGENTS.md")))).toBe("aea61be7ae7507f4555440e52eddef6c6d4331c0d1d20e5da843223ba9757b0e");
  expect(OLD_AGENTS.has("6ecc3a5571398b8490f4b384b32c191e56111e3eebe092e1ccf03790f2ec845b")).toBe(true);
  expect(OLD_AGENTS.has("ff0f49e00a04cec590ee023394221e8bbf28dd0439a628e48ea307acaffa0a8e")).toBe(true);
  expect(OLD_AGENTS.has("08de4118ce41e65b76e8b9795595d41e749c9b60d72a4f3f87691d2cbc99e8ab")).toBe(true);
  expect(OLD_AGENTS.has("58be09d0c5a9d6b8a08f055fd4ed62415403b54f0acd4f6596e0473a4b6da875")).toBe(true);
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

test("a space with only the old claude.json gets codex.json and an updated claude.json; edited ones are kept", async () => {
  const c = spacePaths(await tempFolder());
  await mkdir(c.profiles, { recursive: true });
  // The profile shipped before `resume` (hash 0fb830fc...).
  const shipped = '{\n  "id": "claude",\n  "name": "Claude Code",\n  "interactive": ["claude", "--dangerously-skip-permissions", "--mcp-config", "{mcpConfig}"],\n  "nonInteractive": ["claude", "--dangerously-skip-permissions", "-p", "{prompt}"],\n  "mcpConfig": "claude-json"\n}\n';
  expect(OLD_AGENT_PROFILE.has(sha256(shipped))).toBe(true);
  await writeFile(join(c.profiles, "claude.json"), shipped);
  await initSpace(c);
  expect(existsSync(join(c.profiles, "codex.json"))).toBe(true);
  expect(await readFile(join(c.profiles, "claude.json"), "utf8")).toContain("--continue");
  await writeFile(join(c.profiles, "codex.json"), '{"id":"codex","mine":true}');
  await writeFile(join(c.profiles, "claude.json"), '{"id":"claude","mine":true}');
  await initSpace(c);
  expect(await readFile(join(c.profiles, "codex.json"), "utf8")).toBe('{"id":"codex","mine":true}');
  expect(await readFile(join(c.profiles, "claude.json"), "utf8")).toBe('{"id":"claude","mine":true}');
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
  for (const f of ["AGENTS.md", "CLAUDE.md", "browsing-notes.md"]) expect(await readFile(join(c.root, f), "utf8"), f).toBe(await readFile(join(EN, f), "utf8"));
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
  for (const f of ["AGENTS.md", "CLAUDE.md", "browsing-notes.md"]) expect(await readFile(join(c.root, f), "utf8"), f).toBe(await readFile(join(EN, f), "utf8"));
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
  await writeFile(join(c.root, "browsing-notes.md"), "my lessons\n");
  await initSpace(c, "en");
  expect(await readFile(join(c.root, "AGENTS.md"), "utf8")).toBe(agents);
  expect(await readFile(join(c.root, "browsing-notes.md"), "utf8")).toBe("my lessons\n");
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
