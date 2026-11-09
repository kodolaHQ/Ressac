import { expect, test } from "vitest";
import { DeclarationWidget, WEB_WITH_ACCOUNT } from "../../src/accueil/schemas.js";
import { readHome } from "../../src/accueil/lire.js";
import { spacePaths } from "../../src/chemins.js";
import { mkdir } from "node:fs/promises";
import { declarationWidget, writeWidget } from "../aide/accueil.js";
import { tempFolder } from "../aide/temporaire.js";

const base = declarationWidget();
const withHarvest = (harvest: unknown) => DeclarationWidget.safeParse({ ...base, recolte: harvest });

test("web with an account is refused with WEB_AVEC_COMPTE; lireAccueil shows the widget in error with that text", async () => {
  const r = DeclarationWidget.safeParse({ ...base, sources: { compte: ["mail.test"], publiques: [], web: true } });
  expect(r.success).toBe(false);
  if (!r.success) {
    expect(r.error.issues[0]!.path).toEqual(["sources", "web"]);
    expect(r.error.issues[0]!.message).toBe(WEB_WITH_ACCOUNT);
  }
  const c = spacePaths(await tempFolder());
  await mkdir(c.widgets, { recursive: true });
  await writeWidget(c, "w", declarationWidget(undefined, { sources: { compte: ["mail.test"], publiques: [], web: true } }));
  const { widgets } = await readHome(c, await tempFolder());
  const w = widgets[0]!;
  expect("erreur" in w && w.erreur).toContain(WEB_WITH_ACCOUNT);
});

test("web without an account is accepted; without web, sources.web is false", () => {
  const updateEntry = DeclarationWidget.parse({ ...base, sources: { web: true } });
  expect(updateEntry.sources).toEqual({ compte: [], publiques: [], web: true });
  expect(DeclarationWidget.parse(base).sources.web).toBe(false);
  expect(DeclarationWidget.parse({ ...base, sources: { publiques: ["a.test"] } }).sources).toEqual({ compte: [], publiques: ["a.test"], web: false });
});

test("recolte accepts hours alone, minutes alone, both; refuses neither, invalid formats and bounds", () => {
  expect(withHarvest({ heures: ["07:00", "18:30"] }).success).toBe(true);
  expect(withHarvest({ minutes: 60 }).success).toBe(true);
  expect(withHarvest({ minutes: 60, heures: ["07:00"], dureeMaxMinutes: 30, notifier: true }).success).toBe(true);
  const denial = withHarvest({});
  expect(denial.success).toBe(false);
  if (!denial.success) expect(denial.error.issues[0]!.message).toBe("minutes ou heures attendu");
  expect(withHarvest({ dureeMaxMinutes: 5 }).success).toBe(false);
  expect(withHarvest({ heures: ["7:00"] }).success).toBe(false);
  expect(withHarvest({ heures: ["24:00"] }).success).toBe(false);
  expect(withHarvest({ heures: ["07:60"] }).success).toBe(false);
  expect(withHarvest({ heures: [] }).success).toBe(false);
  expect(withHarvest({ heures: ["01:00", "02:00", "03:00", "04:00", "05:00", "06:00", "07:00"] }).success).toBe(false);
  expect(withHarvest({ heures: ["06:00", "06:00"] }).success).toBe(false);
  expect(withHarvest({ minutes: 60, dureeMaxMinutes: 0 }).success).toBe(false);
  expect(withHarvest({ minutes: 60, dureeMaxMinutes: 61 }).success).toBe(false);
  expect(withHarvest({ minutes: 60, dureeMaxMinutes: 60 }).success).toBe(true);
});

test("the Gmail widget.json (account, public ones, recolte.minutes, without web) reads exactly as before", () => {
  const gmail = { ...base, sources: { compte: ["mail.google.com"], publiques: ["fonts.gstatic.com"] }, recolte: { minutes: 30 } };
  expect(DeclarationWidget.parse(gmail)).toEqual({
    nom: base.nom,
    description: base.description,
    tailles: base.tailles,
    recolte: { minutes: 30 },
    sources: { compte: ["mail.google.com"], publiques: ["fonts.gstatic.com"], web: false },
  });
});
