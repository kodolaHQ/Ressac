import { expect, test } from "vitest";
import { nonPrisEnCharge } from "../../noyau/extensions/carte.ts";

test("nonPrisEnCharge lists activeTab, nativeMessaging, userScripts, sidePanel present in the manifest", () => {
  expect(nonPrisEnCharge({ permissions: ["storage", "activeTab", "userScripts"], optional_permissions: ["nativeMessaging"], side_panel: { default_path: "p.html" } })).toEqual([
    "activeTab",
    "nativeMessaging",
    "userScripts",
    "sidePanel",
  ]);
  expect(nonPrisEnCharge({ permissions: ["sidePanel"], side_panel: {} })).toEqual(["sidePanel"]);
  expect(nonPrisEnCharge({ permissions: ["storage", "tabs"] })).toEqual([]);
  expect(nonPrisEnCharge(null)).toEqual([]);
  expect(nonPrisEnCharge({ permissions: "activeTab" })).toEqual([]);
});
