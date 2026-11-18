import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, truncateSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { FILE_MAX, TOTAL_MAX, TREE_FILES_MAX, readInstructionFiles, writeInstructionFiles } from "../../src/container/instruction-files.js";

// realpath: macOS's tmpdir sits under /var, a link, which the walk refuses.
const root = () => realpathSync(mkdtempSync(join(tmpdir(), "ressac-instr-")));

test("reads regular files and walks trees, absent files have no key", () => {
  const r = root();
  writeFileSync(join(r, "AGENTS.md"), "hello");
  mkdirSync(join(r, "skills/a/b"), { recursive: true });
  writeFileSync(join(r, "skills/a/SKILL.md"), "one");
  writeFileSync(join(r, "skills/a/b/x.md"), "two");
  expect(readInstructionFiles({ files: [join(r, "AGENTS.md"), join(r, "nope.md"), join(r, "missing/deep.md")], trees: [join(r, "skills"), join(r, "nothing")] })).toEqual({
    [join(r, "AGENTS.md")]: "hello",
    [join(r, "skills/a/SKILL.md")]: "one",
    [join(r, "skills/a/b/x.md")]: "two",
  });
});

test("a link is shown as a link and revert replaces the link, not its target", () => {
  const r = root();
  mkdirSync(join(r, "ws"));
  writeFileSync(join(r, "secret"), "secret");
  symlinkSync("../secret", join(r, "ws/AGENTS.md"));
  const agents = join(r, "ws/AGENTS.md");
  expect(readInstructionFiles({ files: [agents], trees: [] })).toEqual({ [agents]: "\u0000link:../secret" });
  expect(writeInstructionFiles({ [agents]: "x" })).toBe("done");
  expect(readFileSync(join(r, "secret"), "utf8")).toBe("secret");
  expect(lstatSync(agents).isFile()).toBe(true);
  expect(readFileSync(agents, "utf8")).toBe("x");
});

test("a linked parent folder is refused, never walked", () => {
  const r = root();
  const other = join(r, "other");
  mkdirSync(join(other, "s"), { recursive: true });
  writeFileSync(join(other, "s/SKILL.md"), "outside");
  mkdirSync(join(r, "home"));
  symlinkSync(other, join(r, "home/skills"));
  const skills = join(r, "home/skills");
  expect(readInstructionFiles({ files: [join(skills, "s/SKILL.md")], trees: [skills] })).toEqual({ [skills]: `\u0000link:${other}` });
  // A link inside a tree: marked, not followed.
  mkdirSync(join(r, "tree"));
  symlinkSync(other, join(r, "tree/in"));
  expect(readInstructionFiles({ files: [], trees: [join(r, "tree")] })).toEqual({ [join(r, "tree/in")]: `\u0000link:${other}` });
  expect(writeInstructionFiles({ [join(skills, "s/SKILL.md")]: "pwned" })).toBe("failed");
  expect(writeInstructionFiles({ [join(skills, "s/SKILL.md")]: null })).toBe("failed");
  expect(readFileSync(join(other, "s/SKILL.md"), "utf8")).toBe("outside");
});

test("a file over FILE_MAX is read as a too-long marker", () => {
  const r = root();
  const big = Buffer.alloc(FILE_MAX + 1, "a");
  writeFileSync(join(r, "big.md"), big);
  expect(readInstructionFiles({ files: [join(r, "big.md")], trees: [] })).toEqual({
    [join(r, "big.md")]: `\u0000too-long:${createHash("sha256").update(big).update(String(big.length)).digest("hex")}`,
  });
});

test("a huge sparse file is hashed over its first MiB and its size, never read whole", () => {
  const r = root();
  const huge = join(r, "huge.md");
  writeFileSync(huge, "head");
  const size = 64 * 1024 * 1024 * 1024;
  truncateSync(huge, size);
  const head = Buffer.alloc(1024 * 1024);
  head.write("head");
  const started = Date.now();
  expect(readInstructionFiles({ files: [huge], trees: [] })).toEqual({ [huge]: `\u0000too-long:${createHash("sha256").update(head).update(String(size)).digest("hex")}` });
  expect(Date.now() - started).toBeLessThan(5000);
});

test("folders count toward the tree limit", () => {
  const r = root();
  for (let i = 0; i < 3; i++) mkdirSync(join(r, `d${i}`));
  expect(readInstructionFiles({ files: [], trees: [r] }, { file: FILE_MAX, total: TOTAL_MAX, tree: 2 })).toEqual({ [r]: "\u0000too-many" });
});

test("more than TREE_FILES_MAX files or TOTAL_MAX bytes is a too-many marker at the tree root, other trees still read", () => {
  const many = root();
  for (let i = 0; i <= TREE_FILES_MAX; i++) writeFileSync(join(many, `f${i}`), "");
  const heavy = root();
  const chunk = Buffer.alloc(FILE_MAX, "a");
  for (let i = 0; i <= TOTAL_MAX / FILE_MAX; i++) writeFileSync(join(heavy, `f${i}`), chunk);
  const light = root();
  writeFileSync(join(light, "a.md"), "a");
  expect(readInstructionFiles({ files: [], trees: [many, heavy, light] })).toEqual({ [many]: "\u0000too-many", [heavy]: "\u0000too-many", [join(light, "a.md")]: "a" });
});

test.skipIf(process.getuid?.() === 0)("an unreadable file or folder is an unreadable marker at its path", () => {
  const r = root();
  writeFileSync(join(r, "AGENTS.md"), "x");
  chmodSync(join(r, "AGENTS.md"), 0);
  mkdirSync(join(r, "skills/locked"), { recursive: true });
  writeFileSync(join(r, "skills/locked/SKILL.md"), "s");
  writeFileSync(join(r, "skills/ok.md"), "ok");
  chmodSync(join(r, "skills/locked"), 0);
  try {
    expect(readInstructionFiles({ files: [join(r, "AGENTS.md")], trees: [join(r, "skills")] })).toEqual({
      [join(r, "AGENTS.md")]: "\u0000unreadable",
      [join(r, "skills/locked")]: "\u0000unreadable",
      [join(r, "skills/ok.md")]: "ok",
    });
  } finally {
    chmodSync(join(r, "skills/locked"), 0o755);
  }
});

test("deleting a real folder removes it whole, never following a link inside", () => {
  const r = root();
  writeFileSync(join(r, "outside"), "keep");
  mkdirSync(join(r, "skills/a"), { recursive: true });
  writeFileSync(join(r, "skills/a/SKILL.md"), "s");
  symlinkSync(join(r, "outside"), join(r, "skills/a/link"));
  expect(writeInstructionFiles({ [join(r, "skills")]: null, [join(r, "skills/b/SKILL.md")]: "back" })).toBe("done");
  expect(existsSync(join(r, "skills/a"))).toBe(false);
  expect(readFileSync(join(r, "skills/b/SKILL.md"), "utf8")).toBe("back");
  expect(readFileSync(join(r, "outside"), "utf8")).toBe("keep");
});

test("write creates missing parent folders and deletes null entries", () => {
  const r = root();
  writeFileSync(join(r, "gone.md"), "bye");
  expect(writeInstructionFiles({ [join(r, "a/b/new.md")]: "new", [join(r, "gone.md")]: null, [join(r, "never.md")]: null })).toBe("done");
  expect(readFileSync(join(r, "a/b/new.md"), "utf8")).toBe("new");
  expect(existsSync(join(r, "gone.md"))).toBe(false);
  // A file standing where a folder is needed is refused.
  expect(writeInstructionFiles({ [join(r, "a/b/new.md/x")]: "x" })).toBe("failed");
});

test("a file that is not UTF-8 text is read as a binary marker", () => {
  const r = root();
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe]);
  writeFileSync(join(r, "a.png"), png);
  writeFileSync(join(r, "nul.md"), "a\u0000b");
  const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
  expect(readInstructionFiles({ files: [join(r, "a.png"), join(r, "nul.md")], trees: [] })).toEqual({
    [join(r, "a.png")]: `\u0000binary:${sha(png)}`,
    [join(r, "nul.md")]: `\u0000binary:${sha("a\u0000b")}`,
  });
});
