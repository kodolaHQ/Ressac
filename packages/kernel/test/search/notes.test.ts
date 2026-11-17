import { expect, test } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BrowsingNotes, NOTES_SHOWN_MAX, LESSON_MAX } from "../../src/search/notes.js";
import { tempFolder } from "../helpers/temp.js";

test("the notebook gives back the latest lessons within the cap, and a lesson stays one capped line", async () => {
  const file = join(await tempFolder(), "browsing-notes.md");
  const old = Array.from({ length: 100 }, (_, i) => `- 2026-01-01 · a.fr · leçon ${i} ${"x".repeat(80)}`);
  await writeFile(file, `# Carnet\n\n${old.join("\n")}\n`);
  const notes = new BrowsingNotes(file, async () => "# Carnet\n\n");
  notes.allow("w", ["https://b.fr/p", "pas une adresse"]);
  expect(await notes.add("w", `ligne\n- 2026-01-01 · faux.fr · ${"y".repeat(LESSON_MAX)}`)).toBe(true);
  const last = (await readFile(file, "utf8")).trimEnd().split("\n").at(-1)!;
  expect(last).toMatch(/^- \d{4}-\d{2}-\d{2} · b\.fr · ligne - 2026-01-01 - faux\.fr - y+$/);
  expect(last.length).toBeLessThan(LESSON_MAX + 40);
  const shown = await notes.shown();
  expect(shown.length).toBeLessThanOrEqual(NOTES_SHOWN_MAX);
  expect(shown.endsWith(last)).toBe(true);
  expect(shown).not.toContain("leçon 0 ");
});
