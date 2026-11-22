import { expect, test } from "vitest";
import { join } from "node:path";
import { linkFree } from "../../src/workspace/no-links.js";
import { tempFolder } from "../helpers/temp.js";

test("linkFree: a missing folder is not link-free", async () => {
  const root = await tempFolder();
  expect(await linkFree(root, root)).toBe(true);
  expect(await linkFree(root, join(root, "absent"))).toBe(false);
});
