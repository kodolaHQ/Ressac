import { expect, it } from "vitest";
import type { ShownWidget } from "../shared/api";
import { homeListForBuilder } from "../ui/builder";

it("homeListForBuilder reads the widgets without the theme", async () => {
  const w = { id: "veille" } as ShownWidget;
  const off = () => {};
  const list = homeListForBuilder({ home: { read: async () => ({ widgets: [w], theme: null }), onChange: () => off } as never });
  expect(await list.read()).toEqual([w]);
  expect(list.onChange(() => {})).toBe(off);
});
