#!/usr/bin/env node
// Summary of the approval log (<dataDir>/logs/asks.jsonl): cards by kind, by rule and by site, and per rule how they were answered.
// Usage: node scripts/asks-summary.mjs <file>
import { readFileSync } from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("usage: asks-summary.mjs <asks.jsonl>");
  process.exit(2);
}
const opened = new Map();
const answers = new Map();
for (const raw of readFileSync(file, "utf8").split("\n")) {
  if (!raw.trim()) continue;
  let l;
  try {
    l = JSON.parse(raw);
  } catch {
    continue;
  }
  if ("answer" in l) answers.set(l.id, l);
  else opened.set(l.id, l);
}

const count = (key) => {
  const m = new Map();
  for (const l of opened.values()) m.set(key(l), (m.get(key(l)) ?? 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1]);
};
const table = (title, rows) => {
  console.log(`\n${title}`);
  for (const [k, n] of rows) console.log(`  ${String(n).padStart(5)}  ${k}`);
};

console.log(`${opened.size} cards, ${answers.size} answers (${file})`);
table("By kind", count((l) => l.kind));
table("By kind / rule", count((l) => `${l.kind}  ${l.rule}`));
table("By site", count((l) => l.site ?? "(none)"));

const per = new Map();
for (const l of opened.values()) {
  const k = `${l.kind}  ${l.rule}`;
  const r = per.get(k) ?? { allow: 0, refuse: 0, other: 0, ms: [] };
  const a = answers.get(l.id);
  if (!a) r.other++;
  else if (a.answer.startsWith("allow")) r.allow++;
  else if (a.answer === "refuse") r.refuse++;
  else r.other++;
  if (a) r.ms.push(a.ms);
  per.set(k, r);
}
console.log("\nAnswers per rule (allow / refuse / dismissed+timeout+open, allow ratio, median ms)");
for (const [k, r] of [...per].sort((a, b) => b[1].allow + b[1].refuse + b[1].other - (a[1].allow + a[1].refuse + a[1].other))) {
  const decided = r.allow + r.refuse;
  const median = r.ms.length ? r.ms.sort((a, b) => a - b)[Math.floor(r.ms.length / 2)] : "-";
  console.log(`  ${String(r.allow).padStart(4)} ${String(r.refuse).padStart(4)} ${String(r.other).padStart(4)}  ${decided ? `${Math.round((100 * r.allow) / decided)}%`.padStart(4) : "   -"}  ${String(median).padStart(7)}  ${k}`);
}
