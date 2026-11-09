import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_PROFILE } from "../shared/model";
import { apply } from "../core/state/actions";
import { initialState } from "../core/state/initial-state";
import { validFolder as kernelValidFolder } from "../../../packages/kernel/src/applications/manifest";
import { validFolder } from "../chrome/store/app-folder";

// A login profile's container is `webaios-<id>`, a site app's `webaios-site-<id>`, an agent app's `webaios-app-<dossier>`:
// no profile id may start like the other two, or a profile would share an app's cookies (spike S8).
describe("container names", () => {
  it("no login profile id starts with app- or site-", () => {
    let s = initialState();
    for (let n = 0; n < 50; n++) s = apply(s, { type: "creerEspace", name: `e${n}`, icon: "x", private: false, profile: "nouveau" });
    const ids = [DEFAULT_PROFILE, ...s.profiles.map((p) => p.id)];
    expect(ids.length).toBeGreaterThan(50);
    for (const id of ids) expect(id).not.toMatch(/^(app|site)-/);
  });
});

it("the chrome's validFolder is the kernel's", () => {
  for (const d of ["essai", "My-app_2.0", "a", "", ".", "..", ".cache", "-x", "a b", "a/b", "a\\b", "é", "a;b", "a$(x)", "__proto__"]) expect(validFolder(d), d).toBe(kernelValidFolder(d));
  const source = readFileSync(new URL("../../../packages/kernel/src/applications/manifest.ts", import.meta.url), "utf8");
  expect(source).toContain("const FOLDER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;");
});
