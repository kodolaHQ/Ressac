import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("writes one minor update with one complete patch pointing at the release's MAR", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ressac-update-xml-"));
  const mar = path.join(dir, "Ressac-0.1.5.mar");
  const bytes = Buffer.from("not really a MAR, any bytes do");
  writeFileSync(mar, bytes);
  const ini = path.join(dir, "application.ini");
  writeFileSync(ini, "[App]\nVendor=Ressac\nName=Ressac\nVersion=0.1.1\nBuildID=20261114120000\n\n[Gecko]\nMinVersion=159.0.1\n");
  const script = fileURLToPath(new URL("../scripts/update-xml.mjs", import.meta.url));
  const xml = execFileSync("node", [script, mar, ini, "0.1.5", "k3y", "20261114120005"], { encoding: "utf8" });
  const sha512 = createHash("sha512").update(bytes).digest("hex");
  expect(xml.match(/<update /g)).toHaveLength(1);
  expect(xml).toContain('<update type="minor" displayVersion="0.1.5" appVersion="0.1.1" platformVersion="0.1.1" buildID="20261114120005">');
  expect(xml.match(/<patch /g)).toHaveLength(1);
  expect(xml).toContain(
    `<patch type="complete" URL="https://updates.getressac.app/updates/k3y/releases/0.1.5/Ressac-0.1.5.mar" hashFunction="sha512" hashValue="${sha512}" size="${bytes.length}"/>`,
  );
  expect(xml).not.toContain("detailsURL");
});

it("refuses a missing or malformed build ID: application.ini's is not the one the app compares", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ressac-update-xml-"));
  writeFileSync(path.join(dir, "m.mar"), "x");
  writeFileSync(path.join(dir, "application.ini"), "[App]\nVersion=0.1.1\nBuildID=20261114120000\n");
  const script = fileURLToPath(new URL("../scripts/update-xml.mjs", import.meta.url));
  for (const id of [[], ["2026111412"]])
    expect(() => execFileSync("node", [script, path.join(dir, "m.mar"), path.join(dir, "application.ini"), "0.1.5", "k3y", ...id], { stdio: "pipe" })).toThrow();
});
