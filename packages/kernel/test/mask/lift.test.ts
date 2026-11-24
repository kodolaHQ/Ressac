import { expect, test, vi } from "vitest";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { WorkspaceLock } from "../../src/mask/lock.js";
import { changedFileDiff, changedFiles, liftWorkspace, listQuarantine, quarantinePlaces, quarantineStamp, restoreQuarantined } from "../../src/mask/lift.js";
import { Workshop } from "../../src/container/workshop.js";
import { spacePaths } from "../../src/paths.js";
import { fakeRunner, type Response } from "../helpers/fake-runner.js";
import { tempFolder } from "../helpers/temp.js";

const ROOTS = "roots=; for r in /workspace/.ressac/logs /workspace /home/node /tmp /var/tmp /dev/shm /run/lock /var/lock; do [ -d \"$r\" ] && [ ! -L \"$r\" ] && roots=\"$roots $r\"; done";
const SCAN =
  `${ROOTS}; if [ -e /run/ressac-reveal-stamp ]; then set -- -cnewer /run/ressac-reveal-stamp; else set --; fi; ` +
  "exec find $roots -xdev -path /workspace/.ressac -prune -o -type d \"$@\" -printf 'D 0 %p\\0' -o -type d -printf 'd 0 %p\\0' -o \"$@\" -printf '%y %s %p\\0'";
/** The scan's answer: the roots and an old folder (in the reveal's list), changed files, a link, a folder made since. */
const LISTING = [
  "d 0 /workspace", "d 0 /home/node", "d 0 /workspace/proj", "D 0 /workspace/new", "D 0 /workspace/new/deep",
  "f 12 /workspace/notes.txt", "f 3 /workspace/.ressac/logs/app.log", "f 40 /home/node/.claude/x.jsonl", "f 5 /var/tmp/a b",
  "l 9 /workspace/proj/link", "s 0 /tmp/agent.sock", "f 1 /workspace/new/deep/inside.txt",
].map((e) => `${e}\0`).join("");
const SNAPSHOT = ["first", "/workspace", "/home/node", "/workspace/proj", "/home/node/.claude"].map((d) => `${d}\0`).join("");
const UNDER = ["f 1 /workspace/new/deep/inside.txt", "e 0 /workspace/new/empty"].map((e) => `${e}\0`).join("");

/** A started workshop whose scan answers `listing` and the reveal's folder list `snapshot` (null: none); `rules` come first. */
async function setup(o: { listing?: string; snapshot?: string | null; under?: string; rules?: [RegExp, Response][]; absent?: boolean; docker?: string | null } = {}) {
  const root = await tempFolder();
  const { run, calls } = fakeRunner([
    ...(o.rules ?? []),
    [/ info$/, { code: 0 }],
    [/ inspect -f/, o.absent ? { code: 1, stderr: "No such container" } : { code: 0, stdout: "true\n" }],
    [/ exec .*exec find \$roots/, { code: 0, stdout: o.listing ?? LISTING }],
    [/ cat \/run\/ressac-reveal-dirs$/, o.snapshot === null ? { code: 3 } : { code: 0, stdout: o.snapshot ?? SNAPSHOT }],
    [/ -empty -printf /, { code: 0, stdout: o.under ?? UNDER }],
  ]);
  const workshop = new Workshop({ paths: spacePaths(join(root, "space")), docker: o.docker === undefined ? "docker" : o.docker, run });
  const lock = new WorkspaceLock(join(root, "masking", "lock.json"));
  await lock.lock({ names: ["votre code"] });
  const lift = (choice: "quarantine" | "keep" | "delete", remove?: string[]) =>
    liftWorkspace({ lock, workshop, folder: join(root, "masking"), choice, ...(remove ? { remove } : {}), sessionOpen: () => false, locale: () => "fr" });
  return { root, folder: join(root, "masking"), workshop, lock, calls, lift, line: () => calls.map((c) => c.args.join(" ")) };
}
const rmOf = (lines: string[]) => lines.filter((l) => l.includes(" rm -rf -- ")).map((l) => l.split(" rm -rf -- ")[1]);

test("the scan: one find as root over the roots that exist, every non-folder by ctime against the stamp, every folder marked", async () => {
  const s = await setup();
  await changedFiles(s.workshop);
  expect(s.calls.find((c) => c.args.join(" ").includes("exec find $roots"))!.args).toEqual(["exec", "--privileged", "-u", "root", "-w", "/", "ressac-workshop", "sh", "-c", SCAN]);
});

test("changed entries: files and links by store; a folder missing from the reveal's list is one entry, what it holds is not listed apart", async () => {
  const s = await setup();
  expect(await changedFiles(s.workshop)).toEqual([
    { store: "workspace", path: "/workspace/new", size: 0, kind: "dir" },
    { store: "workspace", path: "/workspace/notes.txt", size: 12, kind: "file" },
    { store: "ressac-logs", path: "/workspace/.ressac/logs/app.log", size: 3, kind: "file" },
    { store: "agent-home", path: "/home/node/.claude/x.jsonl", size: 40, kind: "file" },
    { store: "container-tmp", path: "/var/tmp/a b", size: 5, kind: "file" },
    { store: "workspace", path: "/workspace/proj/link", size: 9, kind: "link" },
    { store: "container-tmp", path: "/tmp/agent.sock", size: 0, kind: "other" },
  ]);
});

test("without the reveal's folder list, every folder is new (fail closed): each root's top folders go whole", async () => {
  const s = await setup({ snapshot: null, listing: ["d 0 /workspace", "d 0 /workspace/proj", "d 0 /workspace/proj/src", "d 0 /home/node/.cache", "f 1 /workspace/proj/src/a.ts"].map((e) => `${e}\0`).join("") });
  expect((await changedFiles(s.workshop)).map((f) => `${f.kind} ${f.path}`)).toEqual(["dir /workspace/proj", "dir /home/node/.cache"]);
});

test("a late list (written after the stamp) vouches for none of its folders changed since the stamp; a first one does", async () => {
  const listing = ["d 0 /workspace", "D 0 /workspace/made", "d 0 /workspace/old"].map((e) => `${e}\0`).join("");
  const dirs = "/workspace\0/workspace/made\0/workspace/old\0";
  expect((await changedFiles((await setup({ listing, snapshot: `late\0${dirs}` })).workshop)).map((f) => f.path)).toEqual(["/workspace/made"]);
  expect(await changedFiles((await setup({ listing, snapshot: `first\0${dirs}` })).workshop)).toEqual([]);
});

test("a removed container is started again (a fresh one has no stamp: everything counts); only no engine at all is nothing", async () => {
  const s = await setup({ absent: true });
  const start = vi.spyOn(s.workshop, "ensureStarted").mockResolvedValue("started");
  expect((await changedFiles(s.workshop)).length).toBeGreaterThan(0);
  expect(start).toHaveBeenCalled();
  const none = await setup({ docker: null });
  expect(await changedFiles(none.workshop)).toEqual([]);
  await none.lift("quarantine");
  expect(none.lock.locked()).toBe(false);
  expect(none.calls).toEqual([]);
});

test("changed entries: a path outside the stores, a folder's content outside it or a failed find throws (fail closed)", async () => {
  await expect(changedFiles((await setup({ listing: "f 1 /etc/passwd\0" })).workshop)).rejects.toThrow();
  await expect(changedFiles((await setup({ listing: "f 1 /workspace/../etc/x\0" })).workshop)).rejects.toThrow();
  await expect(changedFiles((await setup({ rules: [[/exec find \$roots/, { code: 1, stderr: "Permission denied" }]] })).workshop)).rejects.toThrow(/Permission denied/);
  await expect((await setup({ under: "f 1 /etc/shadow\0" })).lift("quarantine")).rejects.toThrow();
});

test("quarantine stamp: the lock's date in safe characters, the current time when empty", () => {
  expect(quarantineStamp("2026-11-23T10:00:00.000Z")).toBe("2026-11-23T100000000Z");
  expect(quarantineStamp("../../x")).toBe("x");
  expect(quarantineStamp("", new Date("2026-11-24T08:00:00.000Z"))).toBe("2026-11-24T080000000Z");
});

test("quarantine (default): agents stopped, files and links copied out (a link as a link), a new folder entry by entry, then removed", async () => {
  const s = await setup();
  const q = join(s.folder, "quarantine", quarantineStamp(s.lock.info()!.since));
  await s.lift("quarantine");
  expect(s.lock.locked()).toBe(false);
  const lines = s.line();
  const kill = lines.findIndex((l) => l.includes("kill -KILL -1"));
  expect(kill).toBeGreaterThan(-1);
  expect(lines.findLastIndex((l) => l.includes("exec find $roots"))).toBeGreaterThan(kill);
  expect(lines.filter((l) => l.startsWith("cp "))).toEqual([
    `cp ressac-workshop:/home/node/.claude/x.jsonl ${join(q, "agent-home/home/node/.claude/x.jsonl")}`,
    `cp ressac-workshop:/var/tmp/a b ${join(q, "container-tmp/var/tmp/a b")}`,
    `cp ressac-workshop:/workspace/.ressac/logs/app.log ${join(q, "ressac-logs/workspace/.ressac/logs/app.log")}`,
    `cp ressac-workshop:/workspace/new/deep/inside.txt ${join(q, "workspace/workspace/new/deep/inside.txt")}`,
    `cp ressac-workshop:/workspace/notes.txt ${join(q, "workspace/workspace/notes.txt")}`,
    `cp ressac-workshop:/workspace/proj/link ${join(q, "workspace/workspace/proj/link")}`,
  ]);
  // The empty folder's name is kept on the Mac; the socket holds nothing to copy.
  expect(existsSync(join(q, "workspace/workspace/new/empty"))).toBe(true);
  expect(rmOf(lines)).toEqual(["/workspace/new", "/workspace/notes.txt", "/workspace/.ressac/logs/app.log", "/home/node/.claude/x.jsonl", "/var/tmp/a b", "/workspace/proj/link", "/tmp/agent.sock"]);
  expect(lines.indexOf(`cp ressac-workshop:/workspace/notes.txt ${join(q, "workspace/workspace/notes.txt")}`)).toBeLessThan(lines.findIndex((l) => l.endsWith("rm -rf -- /workspace/notes.txt")));
  // The folders left empty, deepest first, never a root.
  expect(lines.find((l) => l.includes(" rmdir "))).toBe("exec --privileged -u root -w / ressac-workshop rmdir --ignore-fail-on-non-empty -- /home/node/.claude /workspace/proj");
  expect(lines.at(-1)).toBe("exec -u root -w / ressac-workshop rm -f /run/ressac-reveal-stamp /run/ressac-reveal-dirs");
});

test("delete removes every changed entry without a copy; keep removes only the chosen ones among them", async () => {
  const d = await setup();
  await d.lift("delete");
  expect(d.line().filter((l) => l.startsWith("cp "))).toEqual([]);
  expect(rmOf(d.line())).toHaveLength(7);
  expect(d.lock.locked()).toBe(false);

  const k = await setup();
  await k.lift("keep", ["/workspace/notes.txt", "/etc/passwd"]);
  expect(rmOf(k.line())).toEqual(["/workspace/notes.txt"]);
  expect(k.line().filter((l) => l.startsWith("cp "))).toEqual([]);
  expect(k.lock.locked()).toBe(false);
});

test("refused while a session is open: nothing runs, the lock stays", async () => {
  const s = await setup();
  await expect(liftWorkspace({ lock: s.lock, workshop: s.workshop, folder: s.folder, choice: "quarantine", sessionOpen: () => true, locale: () => "fr" })).rejects.toThrow(
    "Arrêtez la conversation pour lever le verrou",
  );
  expect(s.calls).toEqual([]);
  expect(s.lock.locked()).toBe(true);
});

test("a failed copy keeps the lock, names the file, removes nothing and keeps the stamp", async () => {
  const s = await setup({ rules: [[/^docker cp ressac-workshop:\/home\/node/, { code: 1, stderr: "no space" }]] });
  await expect(s.lift("quarantine")).rejects.toThrow(/\/home\/node\/\.claude\/x\.jsonl/);
  expect(s.lock.locked()).toBe(true);
  expect(rmOf(s.line())).toEqual([]);
  expect(s.line().some((l) => l.includes("rm -f /run/ressac-reveal-stamp"))).toBe(false);
});

test("a failed removal keeps the lock too", async () => {
  const s = await setup({ rules: [[/ rm -rf -- \/workspace\/notes\.txt$/, { code: 1, stderr: "busy" }]] });
  await expect(s.lift("delete")).rejects.toThrow(/notes\.txt/);
  expect(s.lock.locked()).toBe(true);
});

test("Mac places: case and normalization folds get ~n, before the extension; a file where a folder is needed too", () => {
  const e = "é";
  expect(
    quarantinePlaces([
      { rel: "workspace/workspace/A.txt", dir: false },
      { rel: "workspace/workspace/a.txt", dir: false },
      { rel: "workspace/workspace/x", dir: false },
      { rel: "workspace/workspace/X/y", dir: false },
      { rel: "workspace/workspace/D/one", dir: false },
      { rel: "workspace/workspace/d/two", dir: false },
      { rel: "workspace/workspace/café", dir: false },
      { rel: `workspace/workspace/caf${e}`, dir: false },
    ]),
  ).toEqual(["workspace/workspace/A.txt", "workspace/workspace/a~1.txt", "workspace/workspace/x", "workspace/workspace/X~1/y", "workspace/workspace/D/one", "workspace/workspace/D/two", "workspace/workspace/café", `workspace/workspace/caf${e}~1`]);
});

test("a lift with clashing names keeps both files, and the quarantine gives each back its own path", async () => {
  const s = await setup({ listing: "f 1 /workspace/A.txt\0f 1 /workspace/a.txt\0", snapshot: "first\0/workspace\0" });
  const q = join(s.folder, "quarantine", quarantineStamp(s.lock.info()!.since));
  await s.lift("quarantine");
  expect(s.line().filter((l) => l.startsWith("cp "))).toEqual([`cp ressac-workshop:/workspace/A.txt ${join(q, "workspace/workspace/A.txt")}`, `cp ressac-workshop:/workspace/a.txt ${join(q, "workspace/workspace/a~1.txt")}`]);
  // The fake runner copies nothing: these stand in for what docker cp wrote.
  await writeFile(join(q, "workspace/workspace/A.txt"), "A");
  await writeFile(join(q, "workspace/workspace/a~1.txt"), "a");
  expect((await listQuarantine(s.folder)).map((f) => f.path)).toEqual(["/workspace/A.txt", "/workspace/a.txt"]);
});

test("« Rendre » writes the file back as the agent's user from stdin (no docker cp, no root), a link as a link, then forgets it", async () => {
  const s = await setup();
  const restore = (id: string) => restoreQuarantined({ folder: s.folder, workshop: s.workshop, id, busy: async () => false, locale: () => "fr" });
  const id = "2026-11-23T100000000Z/workspace/workspace/dir/notes.txt";
  const link = "2026-11-23T100000000Z/workspace/workspace/dir/link";
  await mkdir(join(s.folder, "quarantine", "2026-11-23T100000000Z/workspace/workspace/dir"), { recursive: true });
  await writeFile(join(s.folder, "quarantine", id), "hello\0bin");
  await symlink("../target", join(s.folder, "quarantine", link));
  expect(await listQuarantine(s.folder)).toEqual([
    { id: link, store: "workspace", path: "/workspace/dir/link", size: 9, kind: "link" },
    { id, store: "workspace", path: "/workspace/dir/notes.txt", size: 9, kind: "file" },
  ]);
  await restore(id);
  await restore(link);
  const write = s.calls.find((c) => c.args.at(-1) === "/workspace/dir/notes.txt")!;
  expect(write.args).toEqual(["exec", "-i", "-u", "node", "-w", "/", "ressac-workshop", "sh", "-c", 'mkdir -p -- "$(dirname -- "$1")" && base64 -d > "$1"', "ressac-restore", "/workspace/dir/notes.txt"]);
  expect(Buffer.from(write.opts!.input!, "base64").toString()).toBe("hello\0bin");
  const ln = s.calls.find((c) => c.args.at(-2) === "/workspace/dir/link")!;
  expect(ln.args).toEqual(["exec", "-i", "-u", "node", "-w", "/", "ressac-workshop", "sh", "-c", 'mkdir -p -- "$(dirname -- "$1")" && ln -sfn -- "$2" "$1"', "ressac-restore", "/workspace/dir/link", "../target"]);
  expect(s.line().some((l) => l.startsWith("cp ") || l.includes("chown") || l.includes("-u root"))).toBe(false);
  expect(await listQuarantine(s.folder)).toEqual([]);
});

test("« Rendre » is refused while a conversation or an agent app runs, refuses an id outside the quarantine, keeps the file on a failed write", async () => {
  const s = await setup({ rules: [[/ressac-restore/, { code: 1, stderr: "nope" }]] });
  const id = "s/agent-home/home/node/a.txt";
  await mkdir(join(s.folder, "quarantine", "s/agent-home/home/node"), { recursive: true });
  await writeFile(join(s.folder, "quarantine", id), "x");
  await expect(restoreQuarantined({ folder: s.folder, workshop: s.workshop, id, busy: async () => true, locale: () => "fr" })).rejects.toThrow("Arrêtez la conversation et les applis de l'agent pour rendre ce fichier.");
  expect(s.calls).toEqual([]);
  const restore = (x: string) => restoreQuarantined({ folder: s.folder, workshop: s.workshop, id: x, busy: async () => false, locale: () => "fr" });
  for (const bad of ["../lock.json", "s/workspace/../../x", "s/agent-home/etc/passwd", "s/workspace"]) await expect(restore(bad)).rejects.toThrow();
  await expect(restore(id)).rejects.toThrow(/nope/);
  expect(await readFile(join(s.folder, "quarantine", id), "utf8")).toBe("x");
});

test("a changed file shows as added lines read as root; binary and long files say so; a path outside the stores is refused", async () => {
  const s = await setup({ rules: [[/ head -c 200001 -- \/workspace\/a\.txt$/, { code: 0, stdout: "un\ndeux\n" }], [/ head .* \/workspace\/b\.bin$/, { code: 0, stdout: "a\0b" }], [/ head .* \/tmp\/big$/, { code: 0, stdout: "x".repeat(200_001) }]] });
  expect(await changedFileDiff(s.workshop, "/workspace/a.txt")).toEqual({
    path: "/workspace/a.txt",
    status: "added",
    displayable: true,
    blocks: [{ oldStart: 0, oldCount: 0, newStart: 1, newCount: 2, lines: [{ mark: "+", text: "un", old: null, new: 1 }, { mark: "+", text: "deux", old: null, new: 2 }] }],
  });
  expect(s.line().at(-1)).toBe("exec --privileged -u root -w / ressac-workshop head -c 200001 -- /workspace/a.txt");
  expect((await changedFileDiff(s.workshop, "/workspace/b.bin")).displayable).toBe("binary");
  expect((await changedFileDiff(s.workshop, "/tmp/big")).displayable).toBe("too-big");
  await expect(changedFileDiff(s.workshop, "/etc/passwd")).rejects.toThrow();
});
