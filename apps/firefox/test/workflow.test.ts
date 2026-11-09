import { expect, test } from "vitest";
import { aUneVue, urlWorkflow, URL_APPLICATIONS, widgetDeUrlWorkflow } from "../shared/modele";

test("urlWorkflow et widgetDeUrlWorkflow : aller-retour, rien d'autre", () => {
  expect(urlWorkflow("meteo")).toBe("webaios://workflow/meteo");
  expect(widgetDeUrlWorkflow("webaios://workflow/meteo")).toBe("meteo");
  for (const url of ["webaios://workflow/", "webaios://workflow/../etat", "webaios://workflow/A", "webaios://applications", "https://workflow/meteo", "webaios://workflow/a/b"])
    expect(widgetDeUrlWorkflow(url), url).toBeNull();
});

test("une page webaios://workflow/… n'a pas de vue", () => {
  expect(aUneVue(urlWorkflow("meteo"))).toBe(false);
  expect(aUneVue(URL_APPLICATIONS)).toBe(false);
  expect(aUneVue("https://a.test/")).toBe(true);
});
