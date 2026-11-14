// Prints the update.xml of one release: node scripts/update-xml.mjs <signed mar> <application.ini> <display version>
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const [mar, ini, display] = process.argv.slice(2);
if (!mar || !ini || !display) throw new Error("usage: update-xml.mjs <mar> <application.ini> <displayVersion>");
const text = readFileSync(ini, "utf8");
const field = (name) => {
  const m = text.match(new RegExp(`^${name}=(.+)$`, "m"));
  if (!m) throw new Error(`no ${name}= in ${ini}`);
  return m[1].trim();
};
// The updater compares appVersion and buildID with the running app's Gecko version, not the Ressac one.
const version = field("Version");
const bytes = readFileSync(mar);
const url = `https://updates.getressac.app/releases/${display}/Ressac-${display}.mar`;
process.stdout.write(`<?xml version="1.0" encoding="UTF-8"?>
<updates>
  <update type="minor" displayVersion="${display}" appVersion="${version}" platformVersion="${version}" buildID="${field("BuildID")}">
    <patch type="complete" URL="${url}" hashFunction="sha512" hashValue="${createHash("sha512").update(bytes).digest("hex")}" size="${bytes.length}"/>
  </update>
</updates>
`);
