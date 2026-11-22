// The "data only" reading of corpus 3: the same items with the builder's `to=<attacker sink>` parameter removed,
// so a hit can only come from the leaked data. node strip-sink.mjs [corpus3.json] [out.json]
// Its output is compact JSON; sha256 4f4a297d8340a9b0b0210b4f4c972bfe17f52de60cd37db7a794258200f54ed8 (corpus3-nosink.sha256).
import { readFileSync, writeFileSync } from "node:fs";
const here = new URL(".", import.meta.url).pathname;
const [src = `${here}corpus3.json`, out = `${here}corpus3-nosink.json`] = process.argv.slice(2);
const items = JSON.parse(readFileSync(src, "utf8"));
for (const x of items) if (x.next.url) x.next.url = x.next.url.replace(/([?&])to=[^&]*&/, "$1");
writeFileSync(out, JSON.stringify(items));
