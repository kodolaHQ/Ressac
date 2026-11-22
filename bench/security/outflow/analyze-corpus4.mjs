// Tables for a runner-outflow.mts output on corpus 4: node analyze-corpus4.mjs <corpus4.json> <out.json>
// flagged = a search paused (the judged one or an earlier one of the split: `pastHit`) or an address red line.
// A row is as expected when: block → flagged; pass or miss → not flagged.
import { readFileSync } from "node:fs";

const [corpusFile, outFile] = process.argv.slice(2);
const corpus = JSON.parse(readFileSync(corpusFile, "utf8"));
const run = JSON.parse(readFileSync(outFile, "utf8"));
const by = new Map(run.results.map((r) => [r.id, r]));
const rows = corpus.map((x) => {
  const r = by.get(x.id);
  if (!r) throw new Error(`no result for ${x.id}`);
  const flagged = !!(r.hit || r.pastHit);
  return { ...x, r, flagged, ok: x.expected === "block" ? flagged : !flagged };
});
const frac = (k, n) => `${k}/${n}${n ? ` = ${((100 * k) / n).toFixed(1)}%` : ""}`;
const groups = (set) => [...new Set(set.map((x) => x.group))];
const A = rows.filter((x) => x.label === "attack" && x.expected === "block");
const C = rows.filter((x) => x.label === "control" && x.expected === "pass");

console.log(`# ${corpusFile.split("/").pop()} · ${outFile.split("/").pop()}`);
console.log(`rows ${rows.length}: attacks ${A.length}, controls ${C.length}, expected misses ${rows.filter((x) => x.expected === "miss").length}, known false pauses ${rows.filter((x) => x.label === "control" && x.expected === "block").length}`);
console.log(`attacks caught: ${frac(A.filter((x) => x.flagged).length, A.length)}; controls paused: ${frac(C.filter((x) => x.flagged).length, C.length)}; unexpected outcomes: ${rows.filter((x) => !x.ok).length}`);

const V = A.filter((x) => x.form);
console.log("\n## Value rows, caught per group (language or encoding)");
for (const g of groups(V)) {
  const s = V.filter((x) => x.group === g);
  console.log(`${g}\t${frac(s.filter((x) => x.flagged).length, s.length)}`);
}
console.log("\n## Value rows, caught per form");
for (const f of [...new Set(V.map((x) => x.form))]) { const s = V.filter((x) => x.form === f); console.log(`${f}\t${frac(s.filter((x) => x.flagged).length, s.length)}`); }
console.log("\n## Value rows, caught per value");
for (const v of ["code", "door", "client", "lab"]) { const s = V.filter((x) => x.id.split("-").at(-2) === v); console.log(`${v}\t${frac(s.filter((x) => x.flagged).length, s.length)}`); }

console.log("\n## Other rows per group: attacks caught | controls paused");
for (const g of groups(rows.filter((x) => !x.form))) {
  const s = rows.filter((x) => x.group === g && !x.form);
  const a = s.filter((x) => x.label === "attack" && x.expected === "block"), c = s.filter((x) => x.label === "control" && x.expected === "pass");
  console.log(`${g}\t${frac(a.filter((x) => x.flagged).length, a.length)} | ${frac(c.filter((x) => x.flagged).length, c.length)}`);
}

const q = (x) => JSON.stringify([...x.past.filter((g) => g.tool === "search_web").map((g) => g.query), x.next.query].join(" / "));
const how = (x) => (x.r.pastHit ? `paused at ${x.r.pastHit.at}:${x.r.pastHit.hit.kind}:${x.r.pastHit.hit.masked}` : x.r.hit ? `${x.r.hit.kind}:${x.r.hit.masked}` : "-");
console.log("\n## False pauses on controls");
for (const x of C.filter((x) => x.flagged)) console.log(`${x.id}\t${how(x)}\t${q(x)}`);
console.log("\n## Expected misses and known false pauses");
for (const x of rows.filter((x) => x.expected === "miss" || (x.label === "control" && x.expected === "block"))) console.log(`${x.id}\texpected ${x.expected}\t${x.flagged ? "flagged" : "not flagged"} ${how(x)}\t${x.why}`);
console.log("\n## Unexpected outcomes");
for (const x of rows.filter((x) => !x.ok)) console.log(`${x.id}\texpected ${x.expected}\t${x.flagged ? `flagged ${how(x)}` : "not flagged"}\t${q(x)}`);
