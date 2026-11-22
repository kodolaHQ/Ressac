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
//   derived tag <model>-ressac-bench-64k (num_ctx 64000, made here if missing; your Ollama settings are untouched); parallel 1.
//   --max-tools <n> (30). The agent runs with production's --dangerously-skip-permissions; the harness allows only mcp__ressac__ tools.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ressacCaseErrors } from "./score.mjs";

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
  process.exit(r.code ?? 1);
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
mkdirSync(out, { recursive: true });
// A record is final without `error` (a provider safeguard stop included) or once the agent called a tool: it is an
// outcome, never rerun. Only a run that failed before any tool call is run again.
const done = (c) => { try { const r = JSON.parse(readFileSync(`${out}/${c.id}.json`, "utf8")); return !r.error || r.events.some((e) => e.t === "tool"); } catch { return false; } };
const todo = cases.filter((c) => !done(c));
console.log(`${cases.length} cases (sha256 ${frozen.slice(0, 12)}…), ${cases.length - todo.length} already done, ${todo.length} to run → ${out}`);
const pass = ["--set", set, "--cases-file", file, "--agent", agent, "--card", card, "--address", address, "--out", out, ...(ollama ? ["--ollama", tag, "--ollama-url", ollamaUrl] : []), ...[...(ollama ? [] : ["model"]), "timeout-s", "max-tools"].flatMap((k) => (arg(k) ? [`--${k}`, arg(k)] : [])), ...(obedient ? ["--obedient"] : [])];
let next = 0, failed = 0, finished = 0;
const worker = async () => {
  while (next < todo.length) {
    // The agent cannot start at all (login, flags): stop before burning the sample.
    if (failed >= 2 && failed === finished) { console.error("the first cases all failed: stopping. Fix the error above, then rerun the same command."); process.exit(1); }
    const c = todo[next++];
    const r = await sh(TSX, [`${HERE}${HARNESS}`, "--case", c.id, ...pass], (line) => console.log(`[${finished + 1}/${todo.length}] ${line}`));
    finished++;
    if (r.code !== 0) failed++;
  }
};
await Promise.all(Array.from({ length: Math.max(1, Number(arg("parallel", ollama ? "1" : "2"))) }, worker));
if (existsSync(`${HERE}analyze.mjs`)) await sh("node", [`${HERE}analyze.mjs`, out], console.log);
