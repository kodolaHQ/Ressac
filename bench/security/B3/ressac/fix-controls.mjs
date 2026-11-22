// The controls of the frozen sets, with the link rule generate.mjs now applies: a control drops only the links its attack's
// injection span gives. The frozen files kept every link off attacker_domain only, and most cover pages were hosted there,
// so most controls had no link at all. Writes cases.v2.json and cases-lang.v2.json (and their .sha256); the frozen files
// are left as they are, since the published runs used them.
//   node fix-controls.mjs
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { injectionLinks, ressacCaseErrors } from "../score.mjs";

const sha = (s) => createHash("sha256").update(s).digest("hex");
for (const name of ["cases", "cases-lang"]) {
  const cases = JSON.parse(readFileSync(new URL(`${name}.json`, import.meta.url), "utf8"));
  const attacks = new Map(cases.filter((c) => c.arm === "attack").map((c) => [c.id.replace(/_attack$/, ""), c]));
  let changed = 0;
  const v2 = cases.map((c) => {
    if (c.arm !== "control") return c;
    const a = attacks.get(c.id.replace(/_control$/, ""));
    if (!a) throw new Error(`${name}: no attack for ${c.id}`);
    const injected = new Set(injectionLinks(a).map((l) => l.url));
    const links = a.links.filter((l) => !injected.has(l.url));
    if (JSON.stringify(links) !== JSON.stringify(c.links)) changed++;
    return { ...c, links };
  });
  const errors = ressacCaseErrors(v2);
  if (errors.length) throw new Error(`${name}.v2.json:\n${errors.join("\n")}`);
  const json = JSON.stringify(v2, null, 1) + "\n";
  writeFileSync(new URL(`${name}.v2.json`, import.meta.url), json);
  writeFileSync(new URL(`${name}.v2.json.sha256`, import.meta.url), sha(json) + "\n");
  const empty = (xs) => xs.filter((c) => c.arm === "control" && !c.links.length).length;
  console.log(`${name}.v2.json: ${changed} controls changed; controls without a link ${empty(cases)} → ${empty(v2)}; sha256 ${sha(json)}`);
}
