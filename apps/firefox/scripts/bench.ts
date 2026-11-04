// Usage: node scripts/bench.ts [--headed] [--out <file>]
// Runs the Electron then Firefox bench e2e 3 times, one at a time, and compares the medians.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { compare, type BenchFile } from "./bench-stats.ts";

const args = process.argv.slice(2);
const headed = args.includes("--headed");
const outIndex = args.indexOf("--out");
const out = outIndex >= 0 ? args[outIndex + 1] : undefined;
if (outIndex >= 0 && !out) throw new Error("--out needs a file");

const root = resolve(import.meta.dirname, "../../..");
const tmp = mkdtempSync(join(tmpdir(), "webaios-bench-"));

function run(cmd: string, cmdArgs: string[], cwd: string, env: Record<string, string> = {}): void {
  const r = spawnSync(cmd, cmdArgs, { cwd, stdio: "inherit", env: { ...process.env, ...env } });
  if (r.status !== 0) throw new Error(`${cmd} ${cmdArgs.join(" ")} failed (${r.status})`);
}

const electronDir = join(root, "apps/navigateur");
const firefoxDir = join(root, "apps/firefox");
run("corepack", ["pnpm", "exec", "electron-vite", "build"], electronDir);

const files: BenchFile[] = [];
for (let i = 1; i <= 3; i++) {
  for (const app of ["electron", "firefox"] as const) {
    const file = join(tmp, `bench-${app}-${i}.json`);
    const env: Record<string, string> = { WEBAIOS_BENCH: "1", WEBAIOS_BENCH_OUT: file, ...(headed ? { WEBAIOS_BENCH_HEADED: "1" } : {}) };
    try {
      if (app === "electron") run("corepack", ["pnpm", "exec", "playwright", "test", "e2e/bench.spec.ts", "--workers", "1"], electronDir, env);
      else run("corepack", ["pnpm", "exec", "vitest", "run", "-c", "vitest.e2e.config.ts", "e2e/bench.e2e.ts"], firefoxDir, env);
    } catch (e) {
      // Keep what was measured so far (earlier runs, and this run's passed benches) before giving up.
      if (existsSync(file)) files.push(JSON.parse(readFileSync(file, "utf8")) as BenchFile);
      if (out) writeFileSync(out, JSON.stringify({ headed, files, error: `${app} run ${i}: ${(e as Error).message}` }, null, 2));
      throw e;
    }
    files.push(JSON.parse(readFileSync(file, "utf8")) as BenchFile);
  }
}

const rows = compare(files);
const fmt = (n: number | null, d = 1) => (n === null ? "-" : n.toFixed(d));
console.log(["measure", "E", "F", "F/E", "verdict"].join(" | "));
for (const r of rows) console.log([r.measure, fmt(r.electron), fmt(r.firefox), fmt(r.ratio, 2), r.verdict].join(" | "));
if (out) writeFileSync(out, JSON.stringify({ headed, files, rows }, null, 2));
process.exit(rows.some((r) => r.verdict === "too slow") ? 1 : 0);
