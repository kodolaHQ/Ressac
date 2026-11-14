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
