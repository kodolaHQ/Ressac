import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PROFIL_DEFAUT } from "../shared/modele";
import { appliquer } from "../core/etat/actions";
import { etatInitial } from "../core/etat/etat-initial";
import { dossierValide as noyau } from "../../../packages/noyau/src/applications/manifeste";
import { dossierValide } from "../chrome/store/app-folder";

// A login profile's container is `webaios-<id>`, a site app's `webaios-site-<id>`, an agent app's `webaios-app-<dossier>`:
// no profile id may start like the other two, or a profile would share an app's cookies (spike S8).
describe("container names", () => {
  it("no login profile id starts with app- or site-", () => {
    let s = etatInitial();
    for (let n = 0; n < 50; n++) s = appliquer(s, { type: "creerEspace", nom: `e${n}`, icone: "x", prive: false, profil: "nouveau" });
    const ids = [PROFIL_DEFAUT, ...s.profils.map((p) => p.id)];
    expect(ids.length).toBeGreaterThan(50);
    for (const id of ids) expect(id).not.toMatch(/^(app|site)-/);
  });
});

it("the chrome's dossierValide is the noyau's", () => {
  for (const d of ["essai", "My-app_2.0", "a", "", ".", "..", ".cache", "-x", "a b", "a/b", "a\\b", "é", "a;b", "a$(x)", "__proto__"]) expect(dossierValide(d), d).toBe(noyau(d));
  const source = readFileSync(new URL("../../../packages/noyau/src/applications/manifeste.ts", import.meta.url), "utf8");
  expect(source).toContain("const NOM_DOSSIER = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;");
});
