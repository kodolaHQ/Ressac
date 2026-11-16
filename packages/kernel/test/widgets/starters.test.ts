import { expect, test } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const TEMPLATES = join(import.meta.dirname, "..", "..", "templates");

// A new space's starters must work held to their declared domains. Only literal hosts are checked: a templated
// address (`{url}`, per item) reads whatever the item says, which the seeding at first start (`web: true`) covers.
test("every literal host a starter widget reads is declared in its sources", async () => {
  for (const lang of await readdir(TEMPLATES)) {
    const widgets = join(TEMPLATES, lang, "widgets");
    for (const id of await readdir(widgets).catch(() => [])) {
      const folder = join(widgets, id);
      const { sources } = JSON.parse(await readFile(join(folder, "widget.json"), "utf8"));
      const declared = new Set([...(sources.public ?? []), ...(sources.account ?? [])]);
      const texts = await Promise.all((await readdir(folder)).filter((f) => f.endsWith(".mjs") || f === "workflow.json").map((f) => readFile(join(folder, f), "utf8")));
      const hosts = texts.flatMap((t) => [...t.matchAll(/https?:\/\/([a-z0-9.-]+)/g)].map((m) => m[1]!));
      expect(hosts.length, `${lang}/${id}`).toBeGreaterThan(0);
      for (const h of hosts) expect(declared.has(h), `${lang}/${id} reads ${h}`).toBe(true);
    }
  }
});
