import { expect, test } from "vitest";
import { DeclarationWidget, WEB_WITH_ACCOUNT } from "../../src/home/schemas.js";
import { readHome } from "../../src/home/read.js";
import { spacePaths } from "../../src/paths.js";
import { mkdir } from "node:fs/promises";
import { declarationWidget, writeWidget } from "../helpers/home.js";
import { tempFolder } from "../helpers/temp.js";

const base = declarationWidget();
const withHarvest = (harvest: unknown) => DeclarationWidget.safeParse({ ...base, harvest: harvest });

test("web with an account is refused with WEB_WITH_ACCOUNT; lireAccueil shows the widget in error with that text", async () => {
  const r = DeclarationWidget.safeParse({ ...base, sources: { account: ["mail.test"], public: [], web: true } });
  expect(r.success).toBe(false);
  if (!r.success) {
    expect(r.error.issues[0]!.path).toEqual(["sources", "web"]);
    expect(r.error.issues[0]!.message).toBe(WEB_WITH_ACCOUNT);
  }
  const c = spacePaths(await tempFolder());
  await mkdir(c.widgets, { recursive: true });
  await writeWidget(c, "w", declarationWidget(undefined, { sources: { account: ["mail.test"], public: [], web: true } }));
  const { widgets } = await readHome(c, await tempFolder());
  const w = widgets[0]!;
  expect("error" in w && w.error).toContain(WEB_WITH_ACCOUNT);
});

test("web without an account is accepted; without web, sources.web is false", () => {
  const updateEntry = DeclarationWidget.parse({ ...base, sources: { web: true } });
  expect(updateEntry.sources).toEqual({ account: [], public: [], web: true });
  expect(DeclarationWidget.parse(base).sources.web).toBe(false);
  expect(DeclarationWidget.parse({ ...base, sources: { public: ["a.test"] } }).sources).toEqual({ account: [], public: ["a.test"], web: false });
});

test("recolte accepts hours alone, minutes alone, both; refuses neither, invalid formats and bounds", () => {
  expect(withHarvest({ hours: ["07:00", "18:30"] }).success).toBe(true);
  expect(withHarvest({ minutes: 60 }).success).toBe(true);
  expect(withHarvest({ minutes: 60, hours: ["07:00"], maxDurationMinutes: 30, notify: true }).success).toBe(true);
  const denial = withHarvest({});
  expect(denial.success).toBe(false);
  if (!denial.success) expect(denial.error.issues[0]!.message).toBe("minutes ou hours attendu");
  expect(withHarvest({ maxDurationMinutes: 5 }).success).toBe(false);
  expect(withHarvest({ hours: ["7:00"] }).success).toBe(false);
  expect(withHarvest({ hours: ["24:00"] }).success).toBe(false);
  expect(withHarvest({ hours: ["07:60"] }).success).toBe(false);
  expect(withHarvest({ hours: [] }).success).toBe(false);
  expect(withHarvest({ hours: ["01:00", "02:00", "03:00", "04:00", "05:00", "06:00", "07:00"] }).success).toBe(false);
  expect(withHarvest({ hours: ["06:00", "06:00"] }).success).toBe(false);
  expect(withHarvest({ minutes: 60, maxDurationMinutes: 0 }).success).toBe(false);
  expect(withHarvest({ minutes: 60, maxDurationMinutes: 61 }).success).toBe(false);
  expect(withHarvest({ minutes: 60, maxDurationMinutes: 60 }).success).toBe(true);
});

test("the Gmail widget.json (account, public ones, recolte.minutes, without web) reads exactly as before", () => {
  const gmail = { ...base, sources: { account: ["mail.google.com"], public: ["fonts.gstatic.com"] }, harvest: { minutes: 30 } };
  expect(DeclarationWidget.parse(gmail)).toEqual({
    name: base.name,
    description: base.description,
    sizes: base.sizes,
    harvest: { minutes: 30 },
    sources: { account: ["mail.google.com"], public: ["fonts.gstatic.com"], web: false },
  });
});
