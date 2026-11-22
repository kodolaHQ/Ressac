// Prints the result table (markdown) and counts from results-run.json (+ results-related.json when present).
import { MUTS } from "./muts.mjs";
import { readFileSync, existsSync } from "node:fs";
const S = new URL(".", import.meta.url).pathname;
const run = JSON.parse(readFileSync(`${S}/results-run.json`, "utf8"));
const rel = existsSync(`${S}/results-related.json`) ? JSON.parse(readFileSync(`${S}/results-related.json`, "utf8")) : {};
const esc = (s) => String(s).replace(/\|/g, "\\|");
const c = { total: 0, caught: 0, survived: 0, wider: 0, e2e: 0, e2eCaughtUnit: 0, missing: 0 };
const rows = [];
const surv = [];
for (const m of MUTS) {
  c.total++;
  const a = run[m.id];
  const b = rel[m.id];
  let verdict;
  if (!a) { c.missing++; verdict = "NOT RUN"; }
  else if (a.error) { c.missing++; verdict = "ERROR " + a.error; }
  else if (a.red) { c.caught++; if (m.e2e) c.e2eCaughtUnit++; verdict = `caught (${a.count}): ${esc(a.failed[0].replace(/^[KF]:test\//, ""))}`; }
  else if (b?.red) { c.wider++; verdict = `targeted green; caught by an untargeted test (${b.count}): ${esc(b.failed[0].replace(/^[KF]:test\//, ""))}`; }
  else if (m.e2e || /^W[14]$/.test(m.id)) { m.e2e ??= "e2e/agent.e2e.ts"; c.e2e++; verdict = `no unit test catches it; e2e not run: ${m.e2e}`; surv.push(m.id); }
  else { c.survived++; verdict = "**SURVIVED**" + (b ? "" : " (targeted only)"); surv.push(m.id); }
  rows.push(`| ${m.id} | ${esc(m.guard)} | ${esc(m.what)} | ${verdict} |`);
}
if (process.argv[2] === "counts") console.log(JSON.stringify(c), "\nsurvivors:", surv.join(" "));
else console.log(["| id | guard | mutation lets through | result |", "|---|---|---|---|", ...rows].join("\n"));
