import { execFileSync } from "node:child_process";
import { expect, test } from "vitest";
import { RELAUNCH_SCRIPT, relaunchArgs } from "../chrome/store/relaunch";

test("the relaunch waits for the app to be gone, then opens the bundle with the variables", () => {
  expect(relaunchArgs(42, "/A b/Ressac.app", { K: "v w" })).toEqual(["-c", RELAUNCH_SCRIPT, "sh", "42", "--env", "K=v w", "/A b/Ressac.app"]);
  // The real script, `open` replaced by a print, against a process that lives 0.6 s (not our child: a child of ours
  // would stay a zombie, alive to `kill -0`, while this test blocks).
  const pid = Number(execFileSync("/bin/sh", ["-c", "sleep 0.6 >/dev/null 2>&1 & echo $!"], { encoding: "utf8" }));
  const started = Date.now();
  const args = relaunchArgs(pid, "/A b/Ressac.app", { K: "v w" });
  args[1] = RELAUNCH_SCRIPT.replace("/usr/bin/open", "printf '%s|'");
  expect(execFileSync("/bin/sh", args, { encoding: "utf8" })).toBe("-n|--env|K=v w|/A b/Ressac.app|");
  expect(Date.now() - started).toBeGreaterThan(400);
});
