import type { Execution, ResumeExecution } from "@webaios/kernel";
import { expect, test } from "vitest";
import { previewData } from "../../ui/builder/preview";

const resume = (id: string, attempt = false): ResumeExecution => ({
  id,
  trigger: attempt ? "rejeu" : "manuelle",
  ...(attempt ? { attempt: { start: "tri", origin: "a" } } : {}),
  start: "d",
  end: "f",
  status: "reussie",
  blocks: [],
});
const detail = (id: string, output: { output?: unknown; outputTruncated?: true } | null): Execution =>
  ({
    id,
    version: 1,
    owner: { type: "widget", id: "w" },
    trigger: "manuelle",
    start: "d",
    end: "f",
    status: "reussie",
    blocks: [
      { id: "tri", type: "ia.trier", status: "reussi", start: null, end: null, items: 1, log: [], output: ["x"] },
      ...(output ? [{ id: "fin", type: "sortie", status: "reussi", start: null, end: null, items: 1, log: [], ...output }] : []),
    ],
  }) as Execution;
const widget = { data: { real: 1 }, example: { example: 1 } };

test("the output of the chosen run's output block (a trial included)", () => {
  const r = previewData({ chosen: resume("e-essai", true), detail: detail("e-essai", { output: { attempt: 1 } }), list: [resume("e-essai", true), resume("a")], widget });
  expect(r).toEqual({ data: { attempt: 1 }, mention: false });
});

test("truncated or missing output, last real run: the widget's data", () => {
  const list = [resume("e-essai", true), resume("b"), resume("a")];
  expect(previewData({ chosen: resume("b"), detail: detail("b", { output: '{"coupé', outputTruncated: true }), list: list, widget })).toEqual({
    data: { real: 1 },
    mention: false,
  });
  expect(previewData({ chosen: resume("b"), detail: detail("b", null), list: list, widget })).toEqual({ data: { real: 1 }, mention: false });
});

test("otherwise the example, with the mention", () => {
  const list = [resume("b"), resume("a")];
  expect(previewData({ chosen: resume("a"), detail: detail("a", null), list: list, widget })).toEqual({ data: { example: 1 }, mention: true });
  // Detail not read yet (or from another run): not another run's output.
  expect(previewData({ chosen: resume("a"), detail: detail("b", { output: { b: 1 } }), list: list, widget })).toEqual({ data: { example: 1 }, mention: true });
  // Last real run without widget data: the example too.
  expect(previewData({ chosen: resume("b"), detail: null, list: list, widget: { data: null, example: { example: 1 } } })).toEqual({ data: { example: 1 }, mention: true });
});

test("no run: the widget's data as on the home, without a mention", () => {
  expect(previewData({ chosen: null, detail: null, list: [], widget })).toEqual({ data: { real: 1 }, mention: false });
  expect(previewData({ chosen: null, detail: null, list: [], widget: { data: null, example: { example: 1 } } })).toEqual({ data: { example: 1 }, mention: false });
});

test("last real run that did not succeed: the widget's data, with the mention", () => {
  const failed = { ...resume("b"), status: "echouee" as const };
  expect(previewData({ chosen: failed, detail: detail("b", null), list: [failed, resume("a")], widget })).toEqual({ data: { real: 1 }, mention: true });
  const partial = { ...resume("b"), status: "partielle" as const };
  expect(previewData({ chosen: partial, detail: null, list: [partial], widget })).toEqual({ data: { real: 1 }, mention: false });
});
