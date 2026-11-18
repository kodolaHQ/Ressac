import { expect, test } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spacePaths } from "../../src/paths.js";
import { DEFAULT_TEMPLATES } from "../../src/workspace/initialize.js";
import { ACCEPTED_AGENTS_IN_CONTAINER, InstructionReview, WATCHED, lineDiff, type InstructionIo, type Snapshot } from "../../src/workspace/instructions.js";
import { tempFolder } from "../helpers/temp.js";

const AGENTS = "/workspace/AGENTS.md";
const CODEX_HOME = "/home/node/.codex/AGENTS.md";
const SKILL = "/workspace/.agents/skills/x/SKILL.md";
const template = (lang: string, rel: string) => readFile(join(DEFAULT_TEMPLATES, lang, rel), "utf8");

async function setup(files: Snapshot = {}, locale = "en") {
  const paths = spacePaths(await tempFolder());
  // The workspace as initSpace leaves it: the five shipped texts, then the test's own files on top.
  const disk = new Map<string, string>();
  for (const t of ["AGENTS.md", "guides/widgets.md", "guides/extensions.md", "guides/actions.md", "guides/site-apps.md"]) disk.set(`/workspace/${t}`, await template(locale, t));
  for (const [p, c] of Object.entries(files)) disk.set(p, c);
  const writes: Record<string, string | null>[] = [];
  const io: InstructionIo = {
    async read(fs, trees) {
      // Like the real reader: a watched path, anything under a tree, or a link at or above a watched path.
      return Object.fromEntries([...disk].filter(([p]) => [...fs, ...trees].some((w) => w === p || w.startsWith(`${p}/`)) || trees.some((t) => p.startsWith(`${t}/`))));
    },
    async write(entries) {
      writes.push(entries);
      for (const [p, c] of Object.entries(entries)) c === null ? disk.delete(p) : disk.set(p, c);
    },
  };
  return { disk, writes, review: new InstructionReview(paths, io, DEFAULT_TEMPLATES, () => locale), paths };
}

test("first run: an AGENTS.md equal to the space language's template shows no change", async () => {
  const { review } = await setup({ [AGENTS]: await template("fr", "AGENTS.md") }, "fr");
  expect((await review.pending("claude")).changes).toEqual([]);
});

test("first run: a customised AGENTS.md shows once as changed", async () => {
  const { review } = await setup({ [AGENTS]: "mine" });
  const p = await review.pending("claude");
  expect(p.changes).toMatchObject([{ path: AGENTS, status: "changed" }]);
  await review.keep("claude", p.snapshot);
  expect((await review.pending("claude")).changes).toEqual([]);
});

test("first run: an existing ~/.codex/AGENTS.md shows as created for codex, not for claude", async () => {
  const { review } = await setup({ [CODEX_HOME]: "x" });
  expect((await review.pending("claude")).changes).toEqual([]);
  expect((await review.pending("codex")).changes).toMatchObject([{ path: CODEX_HOME, status: "created" }]);
});

test("a file added under a watched tree shows as created; one removed shows as deleted", async () => {
  const { review, disk } = await setup({ [SKILL]: "s" });
  const p = await review.pending("codex");
  expect(p.changes).toMatchObject([{ path: SKILL, status: "created" }]);
  await review.keep("codex", p.snapshot);
  disk.delete(SKILL);
  expect((await review.pending("codex")).changes).toMatchObject([{ path: SKILL, status: "deleted" }]);
});

test("a shipped text (any language) is accepted silently", async () => {
  const { review, disk, paths } = await setup({ [AGENTS]: await template("en", "AGENTS.md") });
  await review.pending("claude");
  disk.set(AGENTS, await template("fr", "AGENTS.md"));
  expect((await review.pending("claude")).changes).toEqual([]);
  const ref = JSON.parse(await readFile(join(paths.internal, "instructions", "reference.json"), "utf8"));
  expect(ref.files[AGENTS]).toBe(await template("fr", "AGENTS.md"));
});

test("keep stores only the kind's paths", async () => {
  const { review } = await setup({ [AGENTS]: "mine", [CODEX_HOME]: "x" });
  const p = await review.pending("codex");
  await review.keep("claude", p.snapshot);
  const after = await review.pending("codex");
  expect(after.changes.map((c) => c.path)).toEqual([CODEX_HOME]);
});

test("revert writes the reference back: changed restored, created deleted, deleted recreated", async () => {
  const { review, disk, writes } = await setup({ [AGENTS]: await template("en", "AGENTS.md"), [CODEX_HOME]: "kept" });
  await review.keep("codex", await review.pending("codex").then((p) => p.snapshot));
  disk.set(AGENTS, "evil");
  disk.set(SKILL, "new");
  disk.delete(CODEX_HOME);
  const p = await review.pending("codex");
  await review.revert("codex", p.snapshot);
  expect(writes.at(-1)).toEqual({ [AGENTS]: await template("en", "AGENTS.md"), [SKILL]: null, [CODEX_HOME]: "kept" });
  expect((await review.pending("codex")).changes).toEqual([]);
});

test("revert of an entry whose reference is a marker deletes it", async () => {
  const { review, disk, writes } = await setup({ [SKILL]: "\u0000link" });
  const p = await review.pending("codex");
  await review.keep("codex", p.snapshot);
  disk.set(SKILL, "real");
  await review.revert("codex", (await review.pending("codex")).snapshot);
  expect(writes.at(-1)).toEqual({ [SKILL]: null });
});

test("a file over the diff cap gives lines null", async () => {
  const { review } = await setup({ [AGENTS]: Array(2001).fill("l").join("\n") });
  expect((await review.pending("claude")).changes[0]?.lines).toBeNull();
});

test("lineDiff marks removed and added lines", () => {
  expect(lineDiff("a\nb\nc", "a\nx\nc")).toEqual([
    { kind: " ", text: "a" },
    { kind: "-", text: "b" },
    { kind: "+", text: "x" },
    { kind: " ", text: "c" },
  ]);
});

test("acceptedAgents writes the reference AGENTS.md (the template on first run)", async () => {
  const { review, paths } = await setup({}, "fr");
  const path = await review.acceptedAgents();
  expect(path).toBe(join(paths.internal, "instructions", "AGENTS.md"));
  expect(await readFile(path, "utf8")).toBe(await template("fr", "AGENTS.md"));
  expect(ACCEPTED_AGENTS_IN_CONTAINER).toBe("/workspace/.ressac/instructions/AGENTS.md");
  expect(WATCHED.claude.trees).toEqual([]);
});

test("acceptedAgents writes nothing for a marker: no unread text reaches Claude", async () => {
  const { review, disk } = await setup();
  disk.set(AGENTS, "\u0000link:/etc/passwd");
  await review.keep("claude", (await review.pending("claude")).snapshot);
  expect(await readFile(await review.acceptedAgents(), "utf8")).toBe("");
});

test("a created file shows only added lines", async () => {
  const { review } = await setup({ [CODEX_HOME]: "a\nb" });
  expect((await review.pending("codex")).changes[0]?.lines).toEqual([
    { kind: "+", text: "a" },
    { kind: "+", text: "b" },
  ]);
});

test("two concurrent keeps both end up in the reference", async () => {
  const { review } = await setup({ [AGENTS]: "mine", [CODEX_HOME]: "x" });
  const p = await review.pending("codex");
  await Promise.all([review.keep("claude", p.snapshot), review.keep("codex", p.snapshot)]);
  expect((await review.pending("codex")).changes).toEqual([]);
});

test("an unreadable reference throws instead of falling back to the first run", async () => {
  const { review, paths } = await setup();
  await mkdir(join(paths.internal, "instructions"), { recursive: true });
  await writeFile(join(paths.internal, "instructions", "reference.json"), "{ nope");
  await expect(review.pending("claude")).rejects.toThrow();
  await writeFile(join(paths.internal, "instructions", "reference.json"), '{"files":null}');
  await expect(review.pending("claude")).rejects.toThrow();
});

test("revert deletes before it writes: a folder the agent replaced by a link goes before the files beneath it", async () => {
  const link = "/home/node/.codex/skills";
  const skill = `${link}/x/SKILL.md`;
  const { review, disk, writes } = await setup({ [skill]: "s" });
  await review.keep("codex", (await review.pending("codex")).snapshot);
  disk.delete(skill);
  disk.set(link, "\u0000link:/elsewhere");
  await review.revert("codex", (await review.pending("codex")).snapshot);
  expect(Object.entries(writes.at(-1)!)).toEqual([[link, null], [skill, "s"]]);
});

test("a link at a tree root or above a watched file is kept like any change", async () => {
  const { review, disk } = await setup();
  disk.set("/home/node/.codex/skills", "\u0000link:/a");
  disk.set("/home/node/.codex", "\u0000link:/b");
  const p = await review.pending("codex");
  expect(p.changes.map((c) => c.path).sort()).toEqual(["/home/node/.codex", "/home/node/.codex/skills"]);
  await review.keep("codex", p.snapshot);
  expect((await review.pending("codex")).changes).toEqual([]);
  expect((await review.pending("claude")).changes).toEqual([]);
});

const SYSTEM = "/home/node/.codex/skills/.system";

test("Codex's own .system skills are accepted silently while the reference has none, then changes there show", async () => {
  const { review, disk } = await setup({ [`${SYSTEM}/a/SKILL.md`]: "a", [`${SYSTEM}/.codex-system-skills.marker`]: "1" });
  expect((await review.pending("codex")).changes).toEqual([]);
  disk.set(`${SYSTEM}/a/SKILL.md`, "evil");
  expect((await review.pending("codex")).changes).toMatchObject([{ path: `${SYSTEM}/a/SKILL.md`, status: "changed" }]);
});

test("revert of a too-many tree removes the tree, then writes the reference files back", async () => {
  const tree = "/home/node/.codex/skills";
  const { review, disk, writes } = await setup({ [`${tree}/x/SKILL.md`]: "s" });
  await review.keep("codex", (await review.pending("codex")).snapshot);
  disk.delete(`${tree}/x/SKILL.md`);
  disk.set(tree, "\u0000too-many");
  const p = await review.pending("codex");
  expect(p.changes).toMatchObject([{ path: tree, status: "created", lines: null, marker: "too-many" }, { path: `${tree}/x/SKILL.md`, status: "deleted" }]);
  await review.revert("codex", p.snapshot);
  expect(Object.entries(writes.at(-1)!)).toEqual([[tree, null], [`${tree}/x/SKILL.md`, "s"]]);
});

test("a change names its marker kind: link target, binary, unreadable", async () => {
  const { review } = await setup({ [CODEX_HOME]: "\u0000link:/etc", [SKILL]: "\u0000binary:abc", "/workspace/AGENTS.override.md": "\u0000unreadable" });
  const markers = Object.fromEntries((await review.pending("codex")).changes.map((c) => [c.path, c.marker]));
  expect(markers).toEqual({ [CODEX_HOME]: "link:/etc", [SKILL]: "binary", "/workspace/AGENTS.override.md": "unreadable" });
});

test("revert keeps what it replaced in replaced.json, only the changed paths", async () => {
  const { review, disk, paths } = await setup({ [CODEX_HOME]: "kept" });
  await review.keep("codex", (await review.pending("codex")).snapshot);
  disk.set(AGENTS, "mine");
  disk.set(SKILL, "new");
  await review.revert("codex", (await review.pending("codex")).snapshot);
  const saved = JSON.parse(await readFile(join(paths.internal, "instructions", "replaced.json"), "utf8"));
  expect(saved.files).toEqual({ [AGENTS]: "mine", [SKILL]: "new" });
});
