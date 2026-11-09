import { expect, test } from "vitest";
import { hasView, urlWorkflow, URL_APPLICATIONS, widgetDeUrlWorkflow } from "../shared/modele";

test("urlWorkflow and widgetDeUrlWorkflow: round trip, nothing else", () => {
  expect(urlWorkflow("meteo")).toBe("webaios://workflow/meteo");
  expect(widgetDeUrlWorkflow("webaios://workflow/meteo")).toBe("meteo");
  for (const url of ["webaios://workflow/", "webaios://workflow/../etat", "webaios://workflow/A", "webaios://applications", "https://workflow/meteo", "webaios://workflow/a/b"])
    expect(widgetDeUrlWorkflow(url), url).toBeNull();
});

test("a webaios://workflow/… page has no view", () => {
  expect(hasView(urlWorkflow("meteo"))).toBe(false);
  expect(hasView(URL_APPLICATIONS)).toBe(false);
  expect(hasView("https://a.test/")).toBe(true);
});
