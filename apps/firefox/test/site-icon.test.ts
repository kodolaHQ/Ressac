import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { readIcon } from "../host/sites";

const root = mkdtempSync(join(tmpdir(), "ressac-site-icon-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("readIcon", () => {
  const app = join(root, "sites", "vidola");
  mkdirSync(join(app, "img"), { recursive: true });
  writeFileSync(join(app, "img", "icon.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const outside = join(root, "mac");
  mkdirSync(outside);
  writeFileSync(join(outside, "icon.png"), "secret du Mac");
  symlinkSync(outside, join(app, "lien"));

  it("an image of the app's folder, as data:", async () => {
    expect(await readIcon(app, "img/icon.png")).toBe("data:image/png;base64,iVBORw==");
    expect(await readIcon(app, "./img/icon.png")).toBe("data:image/png;base64,iVBORw==");
  });

  it("a folder on the way that is a link, `..`, another type or a missing file: null", async () => {
    expect(await readIcon(app, "lien/icon.png")).toBeNull();
    expect(await readIcon(app, "../vidola/img/icon.png")).toBeNull();
    expect(await readIcon(app, "img/icon.gif")).toBeNull();
    expect(await readIcon(app, "img/absent.png")).toBeNull();
  });
});
