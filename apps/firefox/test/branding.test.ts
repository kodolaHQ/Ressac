import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const dir = join(__dirname, "../configs/branding/webaios");
const sizes = [16, 22, 24, 32, 48, 64, 128, 256, 512];

describe("Halo branding", () => {
  it.each(sizes)("logo%i.png is a square PNG of that size", (n) => {
    const b = readFileSync(join(dir, `logo${n}.png`));
    expect(b.subarray(1, 4).toString()).toBe("PNG");
    expect([b.readUInt32BE(16), b.readUInt32BE(20)]).toEqual([n, n]);
  });

  it("firefox.icns is an icns that is no longer the previous logo", () => {
    const b = readFileSync(join(dir, "firefox.icns"));
    expect(b.subarray(0, 4).toString()).toBe("icns");
    // sha256 of the pre-Halo icon (main before plan 46)
    expect(createHash("sha256").update(b).digest("hex")).not.toBe(
      "48c25a7f3d339aa8f49b946cd3171b6e5bbaf7dfdc0c26cd14d62e48321a9c1f",
    );
  });

  it("Assets.car (what macOS 26+ shows first) carries the Halo AppIcon, not Firefox's from the branding template", () => {
    const b = readFileSync(join(dir, "Assets.car"));
    expect(b.subarray(0, 8).toString()).toBe("BOMStore");
    expect(b.includes("AppIcon")).toBe(true);
    // sha256 of engine/browser/branding/unofficial/Assets.car, which surfer copies when the branding has none
    expect(createHash("sha256").update(b).digest("hex")).not.toBe("a5d14250b9346693ed95add03b2d9a106c4740a83f85e6f6c6b5fbda438e4506");
  });
});
