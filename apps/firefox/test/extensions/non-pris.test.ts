import { expect, test } from "vitest";
import { unsupported } from "../../noyau/extensions/carte.ts";

test("nonPrisEnCharge lists activeTab, nativeMessaging, userScripts, sidePanel present in the manifest", () => {
  expect(unsupported({ permissions: ["storage", "activeTab", "userScripts"], optional_permissions: ["nativeMessaging"], side_panel: { default_path: "p.html" } })).toEqual([
    "activeTab",
    "nativeMessaging",
    "userScripts",
    "sidePanel",
  ]);
  expect(unsupported({ permissions: ["sidePanel"], side_panel: {} })).toEqual(["sidePanel"]);
  expect(unsupported({ permissions: ["storage", "tabs"] })).toEqual([]);
  expect(unsupported(null)).toEqual([]);
  expect(unsupported({ permissions: "activeTab" })).toEqual([]);
});
