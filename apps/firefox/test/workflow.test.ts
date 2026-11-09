import { expect, test } from "vitest";
import { hasView, urlWorkflow, URL_APPLICATIONS, widgetOfWorkflowUrl } from "../shared/model";

test("urlWorkflow and widgetOfWorkflowUrl: round trip, nothing else", () => {
  expect(urlWorkflow("meteo")).toBe("webaios://workflow/meteo");
  expect(widgetOfWorkflowUrl("webaios://workflow/meteo")).toBe("meteo");
  for (const url of ["webaios://workflow/", "webaios://workflow/../etat", "webaios://workflow/A", "webaios://apps", "https://workflow/meteo", "webaios://workflow/a/b"])
    expect(widgetOfWorkflowUrl(url), url).toBeNull();
});

test("a webaios://workflow/… page has no view", () => {
  expect(hasView(urlWorkflow("meteo"))).toBe(false);
  expect(hasView(URL_APPLICATIONS)).toBe(false);
  expect(hasView("https://a.test/")).toBe(true);
});
