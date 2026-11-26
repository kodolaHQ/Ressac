// A deleted discussion's history inside the engine (« Supprimer aussi l'historique dans Claude Code / Codex »): the
// engine's own session files in the workshop's home volume, erased by an argv exec (never a shell string).
import { promises as fs } from "node:fs";
import { dirname } from "node:path";

export type EngineHistory = { engine: "claude" | "codex"; id: string };

/** The ids Chats gives Claude (`randomUUID`). */
const CLAUDE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** The kernel's own check of a Codex thread id (kernel.ts, `codexThread`): no dot, slash, glob character or leading dash. */
const CODEX_ID = /^[0-9A-Za-z][\w-]{0,99}$/;

/**
 * The deletion, run as the container's default user (node). Claude Code keeps `<id>.jsonl` and a same-named folder in
 * `~/.claude/projects/<cwd>/`; Codex a `rollout-<time>-<id>.jsonl` under `~/.codex/sessions` or `archived_sessions`.
 * null: an id of another shape (it is never passed on).
 */
export function historyCommand(h: EngineHistory): string[] | null {
  if (h.engine === "claude" && CLAUDE_ID.test(h.id)) {
    const root = "/home/node/.claude";
    return ["find", root, "-mindepth", "3", "-maxdepth", "3", "-path", `${root}/projects/*`, "(", "-name", `${h.id}.jsonl`, "-o", "-name", h.id, ")", "-exec", "rm", "-rf", "--", "{}", "+"];
  }
  if (h.engine === "codex" && CODEX_ID.test(h.id)) {
    const root = "/home/node/.codex";
    return ["find", root, "(", "-path", `${root}/sessions/*`, "-o", "-path", `${root}/archived_sessions/*`, ")", "-type", "f", "-name", `*-${h.id}.jsonl`, "-delete"];
  }
  return null;
}

/**
 * Erases at once while the workshop runs; otherwise never starts it: the deletion waits in `file` (a list of
 * EngineHistory) for `replay`, at the workshop's next use. A failed run waits there too.
 */
export function createEngineHistory(o: {
  file: string;
  workshop: { state(): Promise<string>; exec(argv: string[]): Promise<{ code: number; stderr: string }> };
}) {
  /** Reads and writes of `file` run one at a time. */
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(f: () => Promise<T>): Promise<T> => {
    const r = queue.then(f);
    queue = r.catch(() => {});
    return r;
  };
  const read = async (): Promise<EngineHistory[]> => {
    try {
      const l = JSON.parse(await fs.readFile(o.file, "utf8"));
      return Array.isArray(l) ? l.filter((h) => h && typeof h.id === "string" && (h.engine === "claude" || h.engine === "codex")) : [];
    } catch {
      return [];
    }
  };
  const write = async (l: EngineHistory[]) => {
    if (!l.length) return fs.rm(o.file, { force: true });
    await fs.mkdir(dirname(o.file), { recursive: true });
    await fs.writeFile(o.file, JSON.stringify(l));
  };
  async function run(h: EngineHistory): Promise<boolean> {
    const argv = historyCommand(h);
    if (!argv) return false;
    const r = await o.workshop.exec(argv).catch((e: Error) => ({ code: 1, stderr: e.message }));
    if (r.code !== 0) console.error(`[chat] ${h.engine} history not erased:`, r.stderr.trim().slice(-300));
    return r.code === 0;
  }

  return {
    async forget(h: EngineHistory): Promise<"done" | "pending" | "failed"> {
      if (!historyCommand(h)) {
        console.error(`[chat] ${h.engine} history not erased: invalid id`);
        return "failed";
      }
      const started = (await o.workshop.state().catch(() => null)) === "started";
      if (started && (await run(h))) return "done";
      // Stopped, or the run failed: tried again at the workshop's next use.
      await serial(async () => write([...(await read()), h]));
      return started ? "failed" : "pending";
    },
    /** The workshop runs: the deletions kept for it; a failed one stays for the next time. */
    replay: (): Promise<void> =>
      serial(async () => {
        const l = await read();
        if (!l.length) return;
        const left: EngineHistory[] = [];
        for (const h of l) if (historyCommand(h) && !(await run(h))) left.push(h);
        await write(left);
      }).catch((e) => console.error("[chat] pending history deletions not applied:", e)),
  };
}
