import { expect, test } from "vitest";
import { inChild } from "../host/confined.ts";

declare const __name: <F>(f: F, name: string) => F;

test("inChild: a function compiled with keepNames (tsx) still runs in the child", async () => {
  // What esbuild keepNames emits for an inner arrow function.
  const fn = (n: number) => __name((x: number) => x * 2, "double")(n);
  expect(await inChild(fn, [21])).toBe(42);
});
