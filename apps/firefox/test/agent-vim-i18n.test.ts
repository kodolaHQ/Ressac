import { expect, test } from "vitest";
import { format } from "../shared/i18n";
import { VIM_KEYS } from "../shared/vim-keys";

// Settings › Raccourcis shows the vim table through messages found by position: the French ones must stay the table's text.
test("the vim table's French messages follow shared/vim-keys.ts", () => {
  VIM_KEYS.forEach((g, i) => {
    expect(format("fr", `agent-vim-${i}-title`)).toBe(g.title);
    g.rows.forEach((r, j) => expect(format("fr", `agent-vim-${i}-${j}`)).toBe(r.action));
  });
  expect(format("fr", "agent-vim-key-escape")).toBe("Échap");
});

test("the vim actor's French fallback matches the French messages", async () => {
  const { FRENCH_VIM_TEXTS, VIM_KEYS } = await import("../shared/vim-keys");
  const { format } = await import("../shared/i18n");
  expect(FRENCH_VIM_TEXTS.paused).toBe(format("fr", "chrome-vim-paused"));
  expect(FRENCH_VIM_TEXTS.escape).toBe(format("fr", "agent-vim-key-escape"));
  expect(FRENCH_VIM_TEXTS.titles).toEqual(VIM_KEYS.map((_, gi) => format("fr", `agent-vim-${gi}-title`)));
});
