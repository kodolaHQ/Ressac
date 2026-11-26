import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AskLine, AskSink } from "../../../packages/kernel/src/index.ts";

/** Past this size, the oldest half of the lines goes: the log stays a few days of cards, never a growing file. */
export const ASKS_LOG_MAX = 1_000_000;

/**
 * The approval log's sink (kernel mcp/asks.ts): one stdout line and one JSON line in `file` per card opened and per answer.
 * The kernel's lines carry kinds, rules and places only (no text, no value, no query): written as they come.
 */
export function asksLog(file: string, max = ASKS_LOG_MAX): AskSink {
  let ready = false;
  return (line: AskLine) => {
    console.error(
      "answer" in line
        ? `[ressac] ask ${line.id.slice(0, 8)} ${line.answer} ${line.ms}ms`
        : `[ressac] ask ${line.id.slice(0, 8)} ${line.kind} ${line.rule}${line.site ? ` ${line.site}${line.path ?? ""}` : ""}${line.tool ? ` (${line.tool})` : ""}`,
    );
    if (!ready) mkdirSync(dirname(file), { recursive: true });
    ready = true;
    appendFileSync(file, JSON.stringify(line) + "\n");
    if (statSync(file).size <= max) return;
    const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
    writeFileSync(file, lines.slice(Math.floor(lines.length / 2)).join("\n") + "\n");
  };
}
