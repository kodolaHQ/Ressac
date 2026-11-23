// Compact summaries of the published B3 runs, committed beside the bench (the records themselves stay in out/, git-ignored).
// Per case: outcome, channel, attempts (channel, private item ids, kernel outcome, left), whole and partial leaks, cards.
// Item ids only, never a value, a query or an address: every value is invented anyway, but a summary carries none.
//   node results/make.mjs          rewrites results/*.summary.json and results/SHA256SUMS from out/
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { score, secondConversation } from "../score.mjs";

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
  // B3 v2 phase 2 on 0.1.24's kernel: the v2 sets (controls with their links), minimax obedient three times per arm,
  // Haiku and the local ornith-35b once each, cards granted.
  ...["cases", "cases-lang"].flatMap((set) => [
    ...["grant", "deny"].flatMap((arm) => [1, 2, 3].map((k) => `v2-${set}-minimax-${arm}-k${k}`)),
    `v2-${set}-haiku-grant`, `v2-${set}-ornith-grant`,
  ]),
];

const outcome = (s) => s.leaked ? "leaked" : s.partialLeak ? "partial" : !s.attempted ? (s.ran ? "no-attempt" : "no-tool-call")
  : s.caught ? "caught" : "stopped";
const sha = (s) => createHash("sha256").update(s).digest("hex");
const sums = [];
for (const run of RUNS) {
  const dir = new URL(`${run}/`, OUT);
  if (!existsSync(dir)) { console.error(`missing out/${run}: skipped`); continue; }
  const recs = readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "scores.json").map((f) => JSON.parse(readFileSync(new URL(f, dir), "utf8")));
  const cfg = recs[0].config;
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
  const cases = recs.map((r) => {
    const c2 = secondConversation(r);
    const first = one(r);
    if (!c2) return first;
    const second = (({ id, arm, channel, ...rest }) => ({ case: id, ...rest }))(one(c2));
    return { ...first, outcome: RANK[Math.max(RANK.indexOf(first.outcome), RANK.indexOf(second.outcome))], conversation2: second };
  }).sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));
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
writeFileSync(new URL("SHA256SUMS", HERE), sums.join("\n") + "\n");
