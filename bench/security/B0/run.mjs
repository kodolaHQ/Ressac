// usage: node run.mjs validate | md | run [ids...] | related [ids...]
import { MUTS } from "./muts.mjs";
import { readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
// The repo the mutations are applied to: RESSAC_WORKTREE (a clean checkout at the measured commit), else this repo.
const ROOT = process.env.RESSAC_WORKTREE ?? new URL("../../..", import.meta.url).pathname.replace(/\/$/, "");
const S = new URL(".", import.meta.url).pathname;
const PKG = { K: ["@ressac/kernel", "packages/kernel"], F: ["firefox-ressac", "apps/firefox"] };
const FLAKY = [/in under \d+ ms/];
const git = (...a) => execFileSync("git", a, { cwd: ROOT, encoding: "utf8" });
const count = (s, f) => s.split(f).length - 1;
const lineOf = (s, f) => s.slice(0, s.indexOf(f)).split("\n").length;

function apply(m) {
  const p = `${ROOT}/${m.file}`;
  const src = readFileSync(p, "utf8");
  const n = count(src, m.find);
  if (n !== 1) throw new Error(`${m.id}: find occurs ${n} times in ${m.file}`);
  writeFileSync(p, src.replace(m.find, () => m.to));
}
const restore = (m) => git("checkout", "--", m.file);

function vitest(pkg, args, timeout) {
  const out = `${S}/out-${pkg}.json`;
  rmSync(out, { force: true });
  const r = spawnSync("corepack", ["pnpm", "--filter", PKG[pkg][0], "exec", "vitest", ...args, "--reporter=json", `--outputFile=${out}`], { cwd: ROOT, encoding: "utf8", timeout: timeout * 1000, killSignal: "SIGKILL" });
  if (r.error?.code === "ETIMEDOUT" || r.signal) { spawnSync("pkill", ["-9", "-f", `${ROOT}.*vitest`]); return { red: true, failed: [`(hang: killed after ${timeout} s)`], n: 1 }; }
  if (!existsSync(out)) return { red: r.status !== 0, failed: r.status !== 0 ? ["(no report) " + (r.stderr || r.stdout).trim().split("\n").slice(-3).join(" | ").slice(0, 300)] : [], n: 0, files: 0 };
  const j = JSON.parse(readFileSync(out, "utf8"));
  const failed = [];
  for (const t of j.testResults) {
    const file = t.name.replace(`${ROOT}/${PKG[pkg][1]}/`, "");
    const bad = t.assertionResults.filter((a) => a.status === "failed" && !FLAKY.some((x) => x.test(a.fullName)));
    for (const a of bad) failed.push(`${file} › ${a.fullName}`);
    if (t.status === "failed" && !t.assertionResults.some((a) => a.status === "failed")) failed.push(`${file} › (file failed to run: ${String(t.message).split("\n")[0].slice(0, 160)})`);
  }
  return { red: failed.length > 0, failed, n: failed.length, files: j.numTotalTestSuites ? j.testResults.length : 0, total: j.numTotalTests };
}

const mode = process.argv[2];
const ids = process.argv.slice(3);
const pick = ids.length ? MUTS.filter((m) => ids.includes(m.id)) : MUTS;
if (mode === "validate") {
  let bad = 0;
  const seen = new Set();
  for (const m of MUTS) {
    if (seen.has(m.id)) { console.log("duplicate id", m.id); bad++; }
    seen.add(m.id);
    try {
      const src = readFileSync(`${ROOT}/${m.file}`, "utf8");
      const n = count(src, m.find);
      if (n !== 1) { console.log(`${m.id}: ${n} occurrences in ${m.file}`); bad++; }
      if (m.find === m.to) { console.log(`${m.id}: no-op`); bad++; }
      for (const t of m.tests) if (!existsSync(`${ROOT}/${PKG[t[0]][1]}/${t.slice(2)}`)) { console.log(`${m.id}: no test file ${t}`); bad++; }
      if (m.e2e && !existsSync(`${ROOT}/apps/firefox/${m.e2e}`)) { console.log(`${m.id}: no e2e file ${m.e2e}`); bad++; }
    } catch (e) { console.log(m.id, e.message); bad++; }
  }
  console.log(`${MUTS.length} mutations, ${bad} problems`);
} else if (mode === "md") {
  const esc = (s) => s.replace(/\|/g, "\\|").replace(/\n\s*/g, " ⏎ ");
  const lines = ["# B0 mutation catalogue", "", `Written before any mutated test run, from the code and SECURITY.md at ${git("rev-parse", "--short", "HEAD").trim()}, without reading the tests (their file names only, to pick the targeted files).`, "", "Each mutation replaces `find` (one exact occurrence) by `to` in one file, runs the targeted unit tests, and is restored with `git checkout`. « e2e » marks a guard whose wiring only runs inside Firefox: the unit tests are still run, the e2e file is named and not run.", "", `${MUTS.length} mutations.`, ""];
  let guard = "";
  for (const m of MUTS) {
    const g = m.file;
    if (g !== guard) { guard = g; lines.push("", `## ${g}`, "", "| id | guard | line | find → to | lets through | targeted tests | e2e |", "|---|---|---|---|---|---|---|"); }
    const src = readFileSync(`${ROOT}/${m.file}`, "utf8");
    lines.push(`| ${m.id} | ${esc(m.guard)} | ${lineOf(src, m.find)} | \`${esc(m.find)}\` → \`${esc(m.to) || "(removed)"}\` | ${esc(m.what)} | ${m.tests.map((t) => t.replace("test/", "").replace(".test.ts", "")).join(", ")} | ${m.e2e ?? ""} |`);
  }
  process.stdout.write(lines.join("\n") + "\n");
} else if (mode === "run" || mode === "related") {
  const resFile = `${S}/results-${mode}.json`;
  const results = existsSync(resFile) ? JSON.parse(readFileSync(resFile, "utf8")) : {};
  for (const m of pick) {
    if (results[m.id] && !ids.length) continue;
    if (git("status", "--porcelain").trim()) throw new Error("worktree not clean before " + m.id);
    const t0 = Date.now();
    let res = { red: false, failed: [], ran: [] };
    try {
      apply(m);
      const pkgs = mode === "run" ? ["K", "F"].filter((p) => m.tests.some((t) => t[0] === p)) : [m.file.startsWith("packages/kernel/") ? "K" : "F"];
      for (const p of pkgs) {
        const args = mode === "run" ? ["run", ...m.tests.filter((t) => t[0] === p).map((t) => t.slice(2))] : ["related", `${ROOT}/${m.file}`, "--run", "--passWithNoTests"];
        const r = vitest(p, args, m.timeout ?? (mode === "run" ? 240 : 600));
        res.ran.push(`${p}:${r.files ?? "?"} files/${r.total ?? "?"} tests`);
        if (r.red) { res.red = true; res.failed.push(...r.failed.map((x) => `${p}:${x}`)); if (mode === "run") break; }
      }
    } catch (e) { res.error = e.message; }
    finally { restore(m); }
    res.count = res.failed.length; res.failed = res.failed.slice(0, 4); res.s = Math.round((Date.now() - t0) / 1000);
    results[m.id] = res;
    writeFileSync(resFile, JSON.stringify(results, null, 1));
    console.log(`${m.id} ${res.error ? "ERROR " + res.error : res.red ? "RED (" + res.count + ") " + res.failed[0] : "green"} [${res.s}s] ${res.ran.join(" ")}`);
  }
  if (git("status", "--porcelain").trim()) throw new Error("worktree not clean at the end");
}
