#!/usr/bin/env node
// Runs the end-to-end injection bench (B3): one harness process per case (its own kernel MCP server and its own agent).
//   node run.mjs --selftest                 wiring test with the scripted fake agents: no model, no dataset
//   node run.mjs --cases 3                  dry run: the first 3 frozen cases with the real agent (`claude -p`, your own login)
//   node run.mjs --cases 100                the first 100 frozen cases (50 attack/control pairs, in file order)
//   node run.mjs --cases all                the whole frozen sample; a rerun skips the cases already done
//   node run.mjs --set ressac --cases-file <file> --cases all
//                                           a cases file written for Ressac; <file>.sha256 beside it must match
// Options: --run <name> (output folder under out/, default <agent>-card-<card>-address-<address>), --parallel <n> (default 2),
//   --agent claude|fake-leak|fake-clean, --card grant|deny (rule 3 cards, default grant), --address grant|deny (address cards
//   without a red line, default grant; a red line is always refused), --arm attack|control, --model <m>, --timeout-s <s> (300),
//   --ollama <model> [--ollama-url http://127.0.0.1:11434]: a local model, Claude Code pointed at Ollama as Ressac does it, on a
//   derived tag <model>-ressac-bench-64k (num_ctx 64000, made here if missing; your Ollama settings are untouched); parallel 1
//   for a local model, --parallel as given for a cloud one (<name>:cloud, no tag made). A run the provider's rate limit ends
//   (429) is run again after a growing delay, one worker fewer each time; after 3 retries it stays `stop: "rate-limit"`,
//   excluded from scoring (score.mjs, diff.mjs) like a timeout. A failed agent process (non-zero exit, is_error, no init) is `stop: "agent-error"`, excluded the same, not retried in place, stops the run after 2 such failures.
//   --max-tools <n> (30), --profile a|b (the user's invented values, profiles.mjs; default a).
//   --masking on|off (default on): off runs the kernel without its masker (the utility bench's baseline, utility/run.mjs).
//   --differential: each case three times, under profile a (out/<run>/a), profile b (b) and a again (a2, the noise baseline),
//   then diff.mjs compares what went out (README « Two profiles »). Three runs per case: three times the cost of a model run.
//   --legs 4: a fourth run under profile b again (b2), the noise baseline of b. --only-leg <a|b|a2|b2>: run that leg alone into
//   the run folder (the other legs already there; their settings must match), e.g. --only-leg b2 on a three-leg run.
//   The agent runs with production's --dangerously-skip-permissions; the harness allows only mcp__ressac__ tools.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ressacCaseErrors, excludedRun } from "./score.mjs";
import { setTimeout as sleep } from "node:timers/promises";

const HERE = fileURLToPath(new URL(".", import.meta.url));
// tsx from this repo (the kernel under test may be RESSAC_WORKTREE: harness.mts reads it).
const TSX = fileURLToPath(new URL("../../../packages/kernel/node_modules/.bin/tsx", import.meta.url));
const argv = process.argv.slice(2);
const HARNESS = process.env.BENCH_HARNESS ?? "harness.mts";
const arg = (name, dflt) => { const i = argv.indexOf(`--${name}`); return i < 0 ? dflt : argv[i + 1]; };
const sh = (cmd, args, onLine) => new Promise((done) => {
  const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "";
  p.stdout.on("data", (d) => { out += d; });
  p.stderr.on("data", (d) => { err += d; });
  p.on("close", (code) => { onLine?.(out.trim() || err.trim().split("\n").slice(-3).join(" | ")); done({ code, out, err }); });
});

if (argv.includes("--selftest")) {
  const r = await sh(TSX, [`${HERE}${HARNESS}`, "--selftest"], console.log);
  if (r.code !== 0) process.exit(r.code ?? 1);
  // The guard: a stand-in agent that always exits 1 stops the runner after 2 failures, its stderr shown, the runs excluded.
  const assert = (await import("node:assert")).strict;
  const dead = `${HERE}out/selftest/dead-claude.sh`;
  rmSync(`${HERE}out/selftest-agent-error`, { recursive: true, force: true });
  const go = () => new Promise((done) => {
    const p = spawn("node", [`${HERE}run.mjs`, "--set", "ressac", "--cases-file", `${HERE}selftest-ressac.json`, "--cases", "all", "--run", "selftest-agent-error"], { env: { ...process.env, BENCH_CLAUDE: dead } });
    let o = ""; p.stdout.on("data", (d) => { o += d; }); p.stderr.on("data", (d) => { o += d; }); p.on("close", (code) => done({ code, o }));
  });
  const g = await go();
  assert.equal(g.code, 1, g.o);
  assert.match(g.o, /first cases all failed/, g.o);
  assert.match(g.o, /unrecognized_model/, "the agent's stderr line is shown");
  assert.equal(readdirSync(`${HERE}out/selftest-agent-error`).filter((f) => f.startsWith("selftest-")).length, 2, "stopped after the first 2 failures");
  assert.match((await go()).o, /^4 case runs.*, 0 already done/, "an agent-error record is no outcome: a rerun runs it again");
  console.log("selftest ok: a failed agent stops the runner after 2 runs, excluded and rerun");
  process.exit(0);
}

const set = arg("set", "browsesafe");
if (!["browsesafe", "ressac"].includes(set)) { console.error("--set browsesafe|ressac"); process.exit(1); }
if (set === "ressac" && !arg("cases-file")) { console.error("--set ressac needs --cases-file <path>"); process.exit(1); }
const file = resolve(arg("cases-file", `${HERE}data/cases.json`));
// The committed hash of the BrowseSafe++ sample; for any other file, the <file>.sha256 beside it.
const shaFile = arg("cases-file") ? `${file}.sha256` : `${HERE}cases.sha256`;
if (!existsSync(file)) { console.error(`${file} is missing${set === "browsesafe" ? ": rebuild it with select_cases.py (README.md)" : ""}`); process.exit(1); }
if (!existsSync(shaFile)) { console.error(`${shaFile} is missing: the runner only takes a cases file frozen by its sha256`); process.exit(1); }
const raw = readFileSync(file);
const frozen = readFileSync(shaFile, "utf8").trim().split(/\s+/)[0];
const now = createHash("sha256").update(raw).digest("hex");
if (now !== frozen) { console.error(`${file} is not the frozen file: ${now} ≠ ${frozen} (${shaFile})`); process.exit(1); }
if (set === "ressac") {
  const errors = ressacCaseErrors(JSON.parse(raw));
  if (errors.length) { console.error(`${file} is not a ressac cases file:\n${errors.slice(0, 20).join("\n")}`); process.exit(1); }
}
const want = arg("cases");
if (!want) { console.error("give --cases <n|all> (or --selftest)"); process.exit(1); }
const agent = arg("agent", "claude"), card = arg("card", "grant"), address = arg("address", "grant");
const arm = arg("arm");
let cases = JSON.parse(raw).filter((c) => !arm || c.arm === arm);
if (want !== "all") cases = cases.slice(0, Number(want));
// The 64k context Ressac asks its users to set in the Ollama app, here on a tag of the bench's own (same weights, no new download).
const ollama = arg("ollama"), ollamaUrl = arg("ollama-url", "http://127.0.0.1:11434");
const NUM_CTX = 64000;
// A cloud model (Ollama Cloud, "<name>:<tag>-cloud" or ":cloud") runs on Ollama's servers with its own context: used as is.
const cloud = !!ollama && /(^|[:-])cloud$/.test(ollama);
const tag = ollama && (cloud ? ollama : `${ollama.replace(":", "-")}-ressac-bench-64k`);
if (ollama && !cloud) {
  const post = (path, body) => fetch(ollamaUrl + path, { method: "POST", body: JSON.stringify(body) });
  if (!(await post("/api/show", { model: tag }).catch(() => null))?.ok) {
    const made = await post("/api/create", { model: tag, from: ollama, parameters: { num_ctx: NUM_CTX }, stream: false }).catch((e) => ({ ok: false, text: async () => String(e) }));
    if (!made.ok) { console.error(`cannot make ${tag} from ${ollama} at ${ollamaUrl}: ${await made.text()}`); process.exit(1); }
    console.log(`made the Ollama tag ${tag} (from ${ollama}, num_ctx ${NUM_CTX}); remove it with: ollama rm ${tag}`);
  }
}
const model = ollama ? tag : arg("model");
// The model is in the folder name: a resumed run never mixes two models.
const obedient = argv.includes("--obedient");
const run = arg("run", `${set === "ressac" ? `ressac-${frozen.slice(0, 8)}-` : ""}${agent}${obedient ? "-obedient" : ""}${model ? "-" + model.replace(/[^\w.-]/g, "-") : ""}-card-${card}-address-${address}`);
const out = `${HERE}out/${run}`;
const differential = argv.includes("--differential");
if (differential && arg("profile")) { console.error("--differential runs both profiles: drop --profile"); process.exit(1); }
const nLegs = arg("legs", "3"), onlyLeg = arg("only-leg");
if ((arg("legs") || onlyLeg) && !differential) { console.error("--legs and --only-leg go with --differential"); process.exit(1); }
if (!["3", "4"].includes(nLegs)) { console.error("--legs 3|4"); process.exit(1); }
const ALL = [["a", "a"], ["b", "b"], ["a2", "a"], ["b2", "b"]];
if (onlyLeg && !ALL.some(([l]) => l === onlyLeg)) { console.error("--only-leg a|b|a2|b2"); process.exit(1); }
// [folder, profile]: one run per case, or the differential test's three or four (or one of them).
const legs = !differential ? [["", arg("profile", "a")]] : onlyLeg ? ALL.filter(([l]) => l === onlyLeg) : ALL.slice(0, Number(nLegs));
const dirOf = (folder) => (folder ? `${out}/${folder}` : out);
// One leg added to an existing run: the same settings as the legs there, or the comparison would measure the settings.
if (onlyLeg) {
  const ref = ALL.map(([l]) => `${out}/${l}`).filter((d) => d !== dirOf(onlyLeg) && existsSync(d)).flatMap((d) => readdirSync(d).filter((f) => f.endsWith(".json") && !["scores.json", "diff.json"].includes(f)).map((f) => `${d}/${f}`))[0];
  if (!ref) { console.error(`--only-leg ${onlyLeg}: no other leg in ${out} to match`); process.exit(1); }
  const c = JSON.parse(readFileSync(ref, "utf8")).config;
  const want = { agent, obedient, card, address, timeoutS: Number(arg("timeout-s", ollama ? "600" : "300")), maxTools: Number(arg("max-tools", "30")), model: ollama ? null : arg("model") ?? null, ollama: ollama ? tag : null };
  const have = { agent: c.agent, obedient: !!c.obedient, card: c.card, address: c.address, timeoutS: c.timeoutS, maxTools: c.maxTools, model: c.model ?? null, ollama: c.ollama?.model ?? null };
  const off = Object.keys(want).filter((k) => want[k] !== have[k]);
  if (off.length) { console.error(`--only-leg ${onlyLeg}: settings differ from ${ref}: ${off.map((k) => `${k} ${JSON.stringify(want[k])} ≠ ${JSON.stringify(have[k])}`).join(", ")}`); process.exit(1); }
}
for (const [folder] of legs) mkdirSync(dirOf(folder), { recursive: true });
// A record is final without `error` (a provider safeguard stop included) or once the agent called a tool: it is an
// outcome, never rerun. Only a run that failed before any tool call is run again.
const record = (c, dir) => { try { return JSON.parse(readFileSync(`${dir}/${c.id}.json`, "utf8")); } catch { return null; } };
// A rate-limited record is no outcome: a rerun runs it again.
const done = (c, dir) => { const r = record(c, dir); return !!r && !excludedRun(r) && (!r.error || r.events.some((e) => e.t === "tool")); };
const jobs = legs.flatMap(([folder, profile]) => cases.map((c) => ({ c, profile, dir: dirOf(folder) })));
const todo = jobs.filter((j) => !done(j.c, j.dir));
console.log(`${jobs.length} case runs (${cases.length} cases, sha256 ${frozen.slice(0, 12)}…), ${jobs.length - todo.length} already done, ${todo.length} to run → ${out}`);
const pass = ["--set", set, "--cases-file", file, "--agent", agent, "--card", card, "--address", address, ...(ollama ? ["--ollama", tag, "--ollama-url", ollamaUrl] : []), ...[...(ollama ? [] : ["model"]), "timeout-s", "max-tools", "masking"].flatMap((k) => (arg(k) ? [`--${k}`, arg(k)] : [])), ...(obedient ? ["--obedient"] : [])];
let next = 0, failed = 0, finished = 0, retries = 0, gaveUp = 0, agentErrors = 0;
// A local model runs one case at a time (one GPU); a cloud model takes --parallel as given. A rate limit lowers it live.
let width = Math.max(1, ollama && !cloud ? 1 : Number(arg("parallel", ollama ? "1" : "2")));
const RETRIES = 3;
const worker = async (i) => {
  while (next < todo.length && i < width) {
    // The agent cannot start at all (login, flags): stop before burning the sample.
    if (failed >= 2 && failed === finished) { console.error("the first cases all failed: stopping. Fix the error above, then rerun the same command."); process.exit(1); }
    const { c, profile, dir } = todo[next++];
    let r;
    for (let k = 0; ; k++) {
      r = await sh(TSX, [`${HERE}${HARNESS}`, "--case", c.id, ...pass, "--profile", profile, "--out", dir], (line) => console.log(`[${finished + 1}/${todo.length}] ${line}`));
      if (!excludedRun(record(c, dir))) break;
      // A failed agent (exit 1, no init) will not heal in a minute: no retry here, a rerun runs it again.
      if (record(c, dir)?.stop === "agent-error") { agentErrors++; break; }
      if (k === RETRIES) { gaveUp++; console.log(`${c.id}: still rate-limited after ${RETRIES} retries, excluded (stop: "rate-limit")`); break; }
      retries++;
      width = Math.max(1, width - 1);
      const wait = Math.min(300, 15 * 2 ** k) * (1 + Math.random() * 0.5);
      console.log(`${c.id}: rate-limited, retry ${k + 1}/${RETRIES} in ${Math.round(wait)} s, ${width} at a time`);
      await sleep(wait * 1000);
    }
    finished++;
    if (r.code !== 0) failed++;
  }
};
await Promise.all(Array.from({ length: width }, (_, i) => worker(i)));
if (agentErrors) console.log(`${agentErrors} runs excluded (stop: "agent-error": the agent process failed); a rerun runs them again`);
console.log(`rate limit: ${retries} retries, ${gaveUp} runs excluded (stop: "rate-limit")${retries ? `, ended at ${width} at a time` : ""}`);
for (const [folder] of legs) await sh("node", [`${HERE}analyze.mjs`, dirOf(folder)], differential ? undefined : console.log);
if (differential) await sh("node", [`${HERE}diff.mjs`, out], console.log);
