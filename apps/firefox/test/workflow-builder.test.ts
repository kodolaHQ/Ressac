import { expect, it } from "vitest";
import type { WidgetAffiche } from "../shared/api";
import { homeListForBuilder } from "../ui/builder";

it("homeListForBuilder reads the widgets without the theme", async () => {
  const w = { id: "veille" } as WidgetAffiche;
  const off = () => {};
  const list = homeListForBuilder({ accueil: { lire: async () => ({ widgets: [w], theme: null }), surChange: () => off } as never });
  expect(await list.lire()).toEqual([w]);
  expect(list.surChange(() => {})).toBe(off);
});
