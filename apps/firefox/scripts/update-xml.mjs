// Prints the update.xml of one release:
// node scripts/update-xml.mjs <signed mar> <application.ini> <display version> <update key> <build ID>
// The MAR sits under the feed's secret folder, updates/<key>/ (scripts/publish.sh).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const [mar, ini, display, key, buildID] = process.argv.slice(2);
if (!mar || !ini || !display || !key || !/^\d{14}$/.test(buildID ?? ""))
  throw new Error("usage: update-xml.mjs <mar> <application.ini> <displayVersion> <update key> <14-digit build ID>");
const text = readFileSync(ini, "utf8");
const field = (name) => {
  const m = text.match(new RegExp(`^${name}=(.+)$`, "m"));
  if (!m) throw new Error(`no ${name}= in ${ini}`);
  return m[1].trim();
};
// The updater compares appVersion and buildID with the running app's Gecko version, not the Ressac one, and with the
// build ID compiled into the binary (Services.appinfo.appBuildID): application.ini's is written seconds later. A wrong
// one makes an up-to-date app download its own version at every check.
const version = field("Version");
const bytes = readFileSync(mar);
const url = `https://updates.getressac.app/updates/${key}/releases/${display}/Ressac-${display}.mar`;
process.stdout.write(`<?xml version="1.0" encoding="UTF-8"?>
<updates>
  <update type="minor" displayVersion="${display}" appVersion="${version}" platformVersion="${version}" buildID="${buildID}">
    <patch type="complete" URL="${url}" hashFunction="sha512" hashValue="${createHash("sha512").update(bytes).digest("hex")}" size="${bytes.length}"/>
  </update>
</updates>
`);
