import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { CHAT_RETENTION_DAYS, ChatStore, type ChatRecord } from "../../core/agent/chat-store";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function store() {
  const dir = join(mkdtempSync(join(tmpdir(), "ressac-chat-store-")), "chats");
  dirs.push(join(dir, ".."));
  return { dir, store: new ChatStore(dir) };
}

const rec = (id: string, o: Partial<ChatRecord> = {}): ChatRecord => ({
  id,
  title: "Bonjour",
  engine: "claude",
  profile: "claude",
  mode: "browser",
  state: "paused",
  updatedAt: 0,
  messages: 0,
  windowId: null,
  spaceId: "perso",
  items: [],
  ...o,
});

test("write then read and list by space; no temporary file is left", async () => {
  const { dir, store: s } = store();
  await s.write(rec("a", { items: [{ kind: "user", id: "u1", text: "Bonjour [NOM_1]" }] }));
  await s.write(rec("b", { spaceId: "travail" }));
  expect((await s.read("a"))?.items).toEqual([{ kind: "user", id: "u1", text: "Bonjour [NOM_1]" }]);
  expect((await s.list("perso")).map((r) => r.id)).toEqual(["a"]);
  expect(readdirSync(dir).sort()).toEqual(["a.json", "b.json"]);
  await s.remove("a");
  expect(await s.read("a")).toBeNull();
});

test("an id that is not a plain name never reaches the file system", async () => {
  const { store: s } = store();
  expect(await s.read("../secret")).toBeNull();
  await expect(s.write(rec("../x"))).rejects.toThrow();
});

test("sweep removes records older than 30 days and keeps the others", async () => {
  const { store: s } = store();
  const day = 24 * 60 * 60 * 1000;
  const now = 100 * day;
  await s.write(rec("old", { updatedAt: now - CHAT_RETENTION_DAYS * day - 1 }));
  await s.write(rec("young", { updatedAt: now - CHAT_RETENTION_DAYS * day + 1 }));
  await s.sweep(now);
  expect((await s.list("perso")).map((r) => r.id)).toEqual(["young"]);
});

test("a discussion saved with the panel's context in its title and bubble reads back clean", async () => {
  const { store: s } = store();
  const text = '[contexte : Gmail — https://mail.google.com/] trie mes mails — Pages : [{"tab":"t1","title":"x","url":"https://a.fr/"}]';
  await s.write(rec("a", { title: text.slice(0, 40), items: [{ kind: "user", id: "u1", text }] }));
  const r = (await s.read("a"))!;
  expect(r.title).toBe("trie mes mails");
  expect(r.items[0]).toEqual({ kind: "user", id: "u1", text, display: "trie mes mails" });
  // A clean one is untouched.
  await s.write(rec("b", { items: [{ kind: "user", id: "u1", text: "Bonjour" }] }));
  expect((await s.read("b"))?.items[0]).toEqual({ kind: "user", id: "u1", text: "Bonjour" });
});

test("a hostile old message (pages markers repeated, never closed) reads back in linear time", async () => {
  const { store: s } = store();
  const text = "x" + ' — [{"title":'.repeat(1500);
  await s.write(rec("a", { title: "[contexte : " + text.slice(0, 20), items: [{ kind: "user", id: "u1", text }] }));
  const t0 = performance.now();
  const r = (await s.read("a"))!;
  // Generous bound: the old regex took seconds on this; a linear parse takes well under a millisecond.
  expect(performance.now() - t0).toBeLessThan(500);
  expect(r.items[0]).toEqual({ kind: "user", id: "u1", text });
});
