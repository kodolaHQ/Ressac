import { expect, it } from "vitest";
import { lineSplitter } from "../chrome/agent/lines";

it("splits UTF-8 chunks into lines, a character cut across chunks included", () => {
  const lines: string[] = [];
  const push = lineSplitter((l) => lines.push(l));
  const bytes = new TextEncoder().encode('{"t":"é"}\nsecond\nthi');
  const cut = bytes.indexOf(0xc3) + 1; // inside "é"
  push(bytes.slice(0, cut).buffer);
  push(bytes.slice(cut).buffer);
  expect(lines).toEqual(['{"t":"é"}', "second"]);
  push(new TextEncoder().encode("rd\n").buffer);
  expect(lines).toEqual(['{"t":"é"}', "second", "third"]);
});
