import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
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

  it("wrong kind, relative, `..` segment, symlinked parent", async () => {
    const roots = [goodComponents, "chrome/ressac-frames/sites", `${join(base, "p", "x")}/../chrome/ressac-frames/sites`, join(link, "chrome", "ressac-frames", "sites"), `${good}/`, 42];
    for (const r of roots) expect(await copyHomeRequest(r, other, home), String(r)).toBeNull();
    expect(await copyComponentRequest(good, other, component)).toBeNull();
    expect(await copyComponentRequest(join(link, "chrome", "ressac-frames", "components"), other, component)).toBeNull();
    expect(await copyComponentRequest(`${goodComponents}/../components`, other, component)).toBeNull();
  });
});
