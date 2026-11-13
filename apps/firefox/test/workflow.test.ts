import { expect, test } from "vitest";
import { hasView, urlWorkflow, URL_APPLICATIONS, widgetOfWorkflowUrl } from "../shared/model";

test("urlWorkflow and widgetOfWorkflowUrl: round trip, nothing else", () => {
  expect(urlWorkflow("meteo")).toBe("ressac://workflow/meteo");
  expect(widgetOfWorkflowUrl("ressac://workflow/meteo")).toBe("meteo");
  for (const url of ["ressac://workflow/", "ressac://workflow/../etat", "ressac://workflow/A", "ressac://apps", "https://workflow/meteo", "ressac://workflow/a/b"])
    expect(widgetOfWorkflowUrl(url), url).toBeNull();
});

test("a ressac://workflow/… page has no view", () => {
  expect(hasView(urlWorkflow("meteo"))).toBe(false);
  expect(hasView(URL_APPLICATIONS)).toBe(false);
  expect(hasView("https://a.test/")).toBe(true);
});
