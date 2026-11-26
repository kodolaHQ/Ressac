import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { ChatItem, ChatSummary } from "../../shared/chat";

/** A discussion is deleted this long after its last update (spec §4). */
export const CHAT_RETENTION_DAYS = 30;

/** One discussion on disk: only what the agent received and said (masked text), never a clear passport value. */
export type ChatRecord = ChatSummary & { windowId: string | null; spaceId: string; engineSessionId?: string; items: ChatItem[] };

/** Ids come from the UI: a plain name only, never a path. */
const ID = /^[\w-]+$/;

/** The discussions, one `<id>.json` per discussion in `<dataDir>/chats/`. */
export class ChatStore {
  constructor(private readonly dir: string) {}

  private path(id: string): string {
    if (!ID.test(id)) throw new Error(`invalid chat id: ${id}`);
    return join(this.dir, `${id}.json`);
  }

  async read(id: string): Promise<ChatRecord | null> {
    if (!ID.test(id)) return null;
    try {
      return JSON.parse(await fs.readFile(this.path(id), "utf8")) as ChatRecord;
    } catch {
      return null;
    }
  }

  private async all(): Promise<ChatRecord[]> {
    const names = await fs.readdir(this.dir).catch(() => [] as string[]);
    const recs = await Promise.all(names.filter((n) => n.endsWith(".json")).map((n) => this.read(n.slice(0, -5))));
    return recs.filter((r): r is ChatRecord => r !== null);
  }

  async list(spaceId: string): Promise<ChatRecord[]> {
    return (await this.all()).filter((r) => r.spaceId === spaceId);
  }

  /** Atomic: a crash leaves the old file or the new one, never half of one. */
  async write(rec: ChatRecord): Promise<void> {
    const target = this.path(rec.id);
    const temp = `${target}.tmp`;
    await fs.mkdir(this.dir, { recursive: true });
    try {
      const file = await fs.open(temp, "w");
      try {
        await file.writeFile(JSON.stringify(rec));
        await file.sync(); // on disk before the rename: a power cut does not leave an empty file
      } finally {
        await file.close();
      }
      await fs.rename(temp, target);
    } catch (e) {
      await fs.rm(temp, { force: true });
      throw e;
    }
  }

  async remove(id: string): Promise<void> {
    await fs.rm(this.path(id), { force: true });
  }

  async sweep(now: number): Promise<void> {
    const limit = now - CHAT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    await Promise.all((await this.all()).filter((r) => r.updatedAt < limit).map((r) => this.remove(r.id)));
  }
}
