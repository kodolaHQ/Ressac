import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { copyComponentRequest, copyHomeRequest } from "../host/home-copy";

const base = realpathSync(mkdtempSync(join(tmpdir(), "ressac-home-copy-root-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));
const frames = (parent: string, kind: string) => {
  const d = join(parent, "chrome", "ressac-frames", kind);
  mkdirSync(d, { recursive: true });
  return d;
};
const home = { id: "vidola", token: "a".repeat(32) };
const component = { name: "barres", token: "a".repeat(32) };

describe("copy requests refuse a bad root", () => {
  const good = frames(join(base, "p"), "sites");
  const goodComponents = frames(join(base, "p"), "components");
  const other = join(base, "other");
  mkdirSync(other);
  const link = join(base, "link");
  symlinkSync(join(base, "p"), link);

  it("a link above the profile is fine, a link at or below <profile>/chrome is refused", async () => {
    const real = join(base, "q");
    mkdirSync(join(real, "chrome", "ressac-frames", "sites"), { recursive: true });
    const above = join(base, "alias");
    symlinkSync(real, above);
    // The folder the chrome makes for this serve, reached through the symlinked ancestor, and a real home to copy.
    mkdirSync(join(real, "chrome", "ressac-frames", "sites", `vidola-${home.token}`));
    mkdirSync(join(other, "vidola", "home"), { recursive: true });
    writeFileSync(join(other, "vidola", "home", "index.html"), "<p>x</p>");
    expect(await copyHomeRequest(join(above, "chrome", "ressac-frames", "sites"), other, home)).toEqual(["index.html"]);
    const evil = join(base, "r");
    mkdirSync(join(evil, "x", "ressac-frames", "sites"), { recursive: true });
    symlinkSync(join(evil, "x"), join(evil, "chrome"));
    expect(await copyHomeRequest(join(evil, "chrome", "ressac-frames", "sites"), other, home)).toBeNull();
    const kindLink = join(base, "s");
    mkdirSync(join(kindLink, "chrome", "ressac-frames"), { recursive: true });
    symlinkSync(other, join(kindLink, "chrome", "ressac-frames", "sites"));
    expect(await copyHomeRequest(join(kindLink, "chrome", "ressac-frames", "sites"), other, home)).toBeNull();
  });

  it("wrong kind, relative, `..` segment, symlinked parent", async () => {
    const roots = [goodComponents, "chrome/ressac-frames/sites", `${join(base, "p", "x")}/../chrome/ressac-frames/sites`, join(link, "chrome", "ressac-frames", "sites"), `${good}/`, 42];
    for (const r of roots) expect(await copyHomeRequest(r, other, home), String(r)).toBeNull();
    expect(await copyComponentRequest(good, other, component)).toBeNull();
    expect(await copyComponentRequest(join(link, "chrome", "ressac-frames", "components"), other, component)).toBeNull();
    expect(await copyComponentRequest(`${goodComponents}/../components`, other, component)).toBeNull();
  });
});
