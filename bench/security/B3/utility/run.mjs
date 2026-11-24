#!/usr/bin/env node
// The utility bench (spec § 9): the honest tasks of cases.json, run through B3's own runner (../run.mjs, one harness per
// task), `--repeat` times, then scored by check.mjs.
//   node run.mjs --masking on|off --model scripted [--repeat 3]       the scripted honest agent (honest.mjs): free, the wiring
//   node run.mjs --masking on|off --model <id> [--repeat 3]           a real model (`claude -p --model <id>`): costs money
//   node run.mjs --masking on|off --ollama <model> [--repeat 3]       a model through Ollama, as ../run.mjs takes it
// Every other option goes to ../run.mjs as is (--parallel, --timeout-s, --card, --address…). --max-tools defaults to 100
// (README « Masking protocol »). Records: ../out/utility-<model>/masking-<on|off>/r<k>/; a rerun skips the tasks done.
// Compare the arms: node check.mjs ../out/utility-<model>/masking-on ../out/utility-<model>/masking-off
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const argv = process.argv.slice(2);
const arg = (name) => { const i = argv.indexOf(`--${name}`); return i < 0 ? undefined : argv[i + 1]; };
const masking = arg("masking"), model = arg("model"), ollama = arg("ollama"), repeat = Number(arg("repeat") ?? 3);
if (!["on", "off"].includes(masking) || !(model || ollama) || !(repeat >= 1)) {
  console.error("usage: node run.mjs --masking on|off (--model <id|scripted> | --ollama <model>) [--repeat 3] [options of ../run.mjs]");
  process.exit(1);
}
const ours = new Set(["--masking", "--model", "--repeat", "--run"]);
const rest = argv.flatMap((a, i) => (ours.has(a) || ours.has(argv[i - 1]) ? [] : [a]));
if (!rest.includes("--max-tools")) rest.push("--max-tools", "100");
const scripted = model === "scripted";
const name = `utility-${(ollama ?? model).replace(/[^\w.-]/g, "-")}/masking-${masking}`;
const run = (k) => new Promise((done) => {
  const args = [`${HERE}../run.mjs`, "--set", "ressac", "--cases-file", `${HERE}cases.json`, "--cases", "all", "--run", `${name}/r${k}`, "--masking", masking,
    ...(scripted || ollama ? [] : ["--model", model]), ...rest];
  const env = scripted ? { ...process.env, BENCH_CLAUDE: `${HERE}honest.mjs` } : process.env;
  spawn("node", args, { stdio: "inherit", env }).on("close", done);
});
for (let k = 1; k <= repeat; k++) {
  console.log(`── repetition ${k} of ${repeat}`);
  if ((await run(k)) !== 0) process.exitCode = 1;
}
spawn("node", [`${HERE}check.mjs`, `${HERE}../out/${name}`], { stdio: "inherit" });
