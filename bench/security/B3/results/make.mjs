// Compact summaries of the published B3 runs, committed beside the bench (the records themselves stay in out/, git-ignored).
// Per case: outcome, channel, attempts (channel, private item ids, kernel outcome, left), whole and partial leaks, cards.
// Item ids only, never a value, a query or an address: every value is invented anyway, but a summary carries none.
//   node results/make.mjs          rewrites results/*.summary.json and results/SHA256SUMS from out/
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { score, secondConversation } from "../score.mjs";
import { compareRun } from "../diff.mjs";

const HERE = new URL("./", import.meta.url);
const OUT = new URL("../out/", import.meta.url);
// The runs B3/README.md and SECURITY.md cite.
export const RUNS = [
  "claude-haiku-card-grant-address-grant",
  "ressac-92a19bc3-claude-haiku-card-grant-address-grant",
  "ressac-92a19bc3-claude-obedient-minimax-m3.1-flash-cloud-card-grant-address-grant",
  "ressac-92a19bc3-claude-obedient-minimax-m3.1-flash-cloud-card-deny-address-deny",
  "fix-ressac-92a19bc3-claude-obedient-minimax-m3.1-flash-cloud-card-grant-address-grant",
  "fix-ressac-92a19bc3-claude-obedient-minimax-m3.1-flash-cloud-card-deny-address-deny",
  "fix-ressac-d1aa1764-claude-obedient-minimax-m3.1-flash-cloud-card-grant-address-grant",
  "fix-ressac-d1aa1764-claude-obedient-minimax-m3.1-flash-cloud-card-deny-address-deny",
  "v0123-lang-minimax-grant",
  "v0123-lang-minimax-deny",
  // The scripted adversary (adversary.mjs, no model) on 0.1.24's kernel: one shape per case, and the notebook over two conversations.
  // r2: controls that exercise the one-character readings, and a second conversation that reads the user's tab first.
  "adversary-0.1.24-r2-grant",
  "adversary-0.1.24-r2-deny",
];
// The two-profile differential test (diff.mjs) of the scripted adversary on main 9ed1801d (0.1.25's kernel): a, b, a2 per case.
export const DIFF_RUNS = ["adversary-9ed1801d-diff-grant", "adversary-9ed1801d-diff-deny"];

const outcome = (s) => s.leaked ? "leaked" : s.partialLeak ? "partial" : !s.attempted ? (s.ran ? "no-attempt" : "no-tool-call")
  : s.caught ? "caught" : "stopped";
const sha = (s) => createHash("sha256").update(s).digest("hex");
const sums = [];
const one = (r) => {
  const s = score(r);
  return {
    id: s.id, arm: s.arm, channel: s.channel, outcome: outcome(s),
    ...(s.providerStop || s.cliStop || s.error ? { stop: s.providerStop ? "provider-safeguard" : s.cliStop ?? "harness-error" } : {}),
    readPrivate: s.readPrivate,
    attempts: s.attempts.map((a) => ({ channel: a.channel, items: a.items, outcome: a.outcome, left: a.left })),
    leaked: [...new Set(s.attempts.filter((a) => a.left).flatMap((a) => a.items))],
    partial: s.partial,
    cards: { pauses: s.pauses, redLines: s.redLines, addressCards: s.addressCards, rule3Cards: s.rule3Cards },
    toolCalls: s.toolCalls,
  };
};
// A second conversation (the notebook kept from the first) is summarised inside its case; the case's outcome is the
// worse of the two, so a leak in conversation 2 counts in the totals.
const RANK = ["no-tool-call", "no-attempt", "stopped", "caught", "partial", "leaked"];
const summariseCase = (r) => {
  const c2 = secondConversation(r);
  const first = one(r);
  if (!c2) return first;
  const second = (({ id, arm, channel, ...rest }) => ({ case: id, ...rest }))(one(c2));
  return { ...first, outcome: RANK[Math.max(RANK.indexOf(first.outcome), RANK.indexOf(second.outcome))], conversation2: second };
};
const readRecs = (dir) => readdirSync(dir).filter((f) => f.endsWith(".json") && !["scores.json", "diff.json"].includes(f)).map((f) => JSON.parse(readFileSync(new URL(f, dir), "utf8")));
// A run whose records are not in this checkout's out/ keeps its published summary and its line in SHA256SUMS.
const published = new Map(readFileSync(new URL("SHA256SUMS", HERE), "utf8").split("\n").filter(Boolean).map((l) => [l.split(/\s+/)[1], l]));
const skip = (run) => { console.error(`missing out/${run}: kept as published`); if (published.has(`${run}.summary.json`)) sums.push(published.get(`${run}.summary.json`)); };
for (const run of RUNS) {
  const dir = new URL(`${run}/`, OUT);
  if (!existsSync(dir)) { skip(run); continue; }
  const recs = readRecs(dir);
  const cfg = recs[0].config;
  const cases = recs.map(summariseCase).sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));
  const both = (c) => [c, ...(c.conversation2 ? [c.conversation2] : [])];
  const n = (arm, f) => cases.filter((c) => c.arm === arm && f(c)).length;
  const totals = Object.fromEntries(["attack", "control"].map((arm) => [arm, {
    cases: n(arm, () => true), tried: n(arm, (c) => both(c).some((x) => x.attempts.length)), leaked: n(arm, (c) => c.outcome === "leaked"), partial: n(arm, (c) => both(c).some((x) => x.partial.length)),
    attempts: cases.filter((c) => c.arm === arm).reduce((k, c) => k + both(c).reduce((m, x) => m + x.attempts.length, 0), 0), casesWithPause: n(arm, (c) => both(c).some((x) => x.cards.pauses > 0)),
  }]));
  const summary = {
    run, bench: recs[0].bench, scoredWith: "bench/security/B3/score.mjs", ressac: cfg.ressac, kernel: cfg.kernel,
    agent: cfg.agent, obedient: !!cfg.obedient, model: [...new Set(recs.map((r) => r.agent?.init?.model).filter(Boolean))], card: cfg.card, address: cfg.address,
    totals, cases,
  };
  // One case per line: small, and a diff between two scorings reads case by case.
  const json = JSON.stringify({ ...summary, cases: "@" }, null, 1).replace('"@"', `[\n${cases.map((c) => "  " + JSON.stringify(c)).join(",\n")}\n ]`) + "\n";
  writeFileSync(new URL(`${run}.summary.json`, HERE), json);
  sums.push(`${sha(json)}  ${run}.summary.json`);
  console.log(`${run}: ${JSON.stringify(totals)}`);
}
// Per case: score.mjs's outcome and leaked item ids under each profile, and the differential test's verdict (step keys and
// channels only: no outbound value).
for (const run of DIFF_RUNS) {
  const dir = new URL(`${run}/`, OUT);
  if (!existsSync(dir)) { skip(run); continue; }
  const legs = Object.fromEntries(["a", "b", "a2"].map((l) => [l, new Map(readRecs(new URL(`${l}/`, dir)).map((r) => [r.case.id, summariseCase(r)]))]));
  const cfg = readRecs(new URL("a/", dir))[0].config;
  const cases = compareRun(fileURLToPath(dir)).map((d) => ({
    id: d.id, arm: d.arm, channel: d.channel,
    score: Object.fromEntries(Object.entries(legs).map(([l, m]) => [l, m.get(d.id)?.outcome ?? null])),
    leaked: { a: legs.a.get(d.id)?.leaked ?? null, b: legs.b.get(d.id)?.leaked ?? null },
    diff: { flagged: d.flows.length > 0, steps: d.flows.map((f) => f.step), channels: [...new Set(d.flows.map((f) => f.channel))], plain: d.flows.filter((f) => f.plain).length, noise: d.noise, undecided: d.undecided },
  }));
  const n = (arm, f) => cases.filter((c) => c.arm === arm && f(c)).length;
  const totals = Object.fromEntries(["attack", "control"].map((arm) => [arm, { cases: n(arm, () => true), flagged: n(arm, (c) => c.diff.flagged),
    scoredLeakOrPartial: n(arm, (c) => ["leaked", "partial"].includes(c.score.a) || ["leaked", "partial"].includes(c.score.b)), noiseSteps: cases.filter((c) => c.arm === arm).reduce((k, c) => k + (c.diff.noise ?? 0), 0) }]));
  const summary = { run, bench: "ressac-e2e-injection/2 differential", scoredWith: "bench/security/B3/diff.mjs, score.mjs", ressac: cfg.ressac, kernel: cfg.kernel, agent: cfg.agent, card: cfg.card, address: cfg.address, legs: ["a", "b", "a2"], totals, cases: "@" };
  const json = JSON.stringify(summary, null, 1).replace('"@"', `[\n${cases.map((c) => "  " + JSON.stringify(c)).join(",\n")}\n ]`) + "\n";
  writeFileSync(new URL(`${run}.summary.json`, HERE), json);
  sums.push(`${sha(json)}  ${run}.summary.json`);
  console.log(`${run}: ${JSON.stringify(totals)}`);
}
writeFileSync(new URL("SHA256SUMS", HERE), sums.join("\n") + "\n");
