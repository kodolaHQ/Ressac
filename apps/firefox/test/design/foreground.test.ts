import { expect, test } from "vitest";
import { chooseDesignTarget } from "../../core/design/foreground";

test("app and site at once → app target", () => {
  expect(chooseDesignTarget({ app: "essai", site: "tuning", otherWindow: true, activeWindow: "f1" })).toEqual({ type: "target", target: { type: "app", folder: "essai" } });
});

test("site alone → site target", () => {
  expect(chooseDesignTarget({ site: "tuning", otherWindow: true, activeWindow: "f1" })).toEqual({ type: "target", target: { type: "site", id: "tuning" } });
});

test("small window of a site app → avis-site, never the active window", () => {
  expect(chooseDesignTarget({ siteSmall: "tuning", otherWindow: true, activeWindow: "f1" })).toEqual({ type: "site-notice", id: "tuning" });
  expect(chooseDesignTarget({ siteSmall: "tuning", otherWindow: false, activeWindow: "f1" })).toEqual({ type: "site-notice", id: "tuning" });
});

test("other window (neither main nor app) with an active window → nothing", () => {
  expect(chooseDesignTarget({ otherWindow: true, activeWindow: "f1" })).toEqual({ type: "none" });
});

test("nothing in the foreground, active window f1 → target window f1", () => {
  expect(chooseDesignTarget({ otherWindow: false, activeWindow: "f1" })).toEqual({ type: "target", target: { type: "window", windowId: "f1" } });
});

test("nothing at all → nothing", () => {
  expect(chooseDesignTarget({ otherWindow: false })).toEqual({ type: "none" });
});
