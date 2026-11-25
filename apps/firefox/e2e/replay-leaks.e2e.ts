import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { openWorld, record, toolCaller, type ReplayCase, type World } from "./replay";
import { agentPanelReady } from "./ui";

/** B3's leak replay in the compiled browser (bench/security/B3/browser): the world, then the scripted adversary on it. */
const B3 = path.resolve(import.meta.dirname, "../../../bench/security/B3");
const frozen = JSON.parse(readFileSync(path.join(B3, "browser/replay-cases.json"), "utf8")) as { e2e: { file: string; ids: string[] } };
const cases = JSON.parse(readFileSync(path.join(B3, frozen.e2e.file), "utf8")) as ReplayCase[];
const byId = (id: string) => cases.find((c) => c.id === id)!;
const { PROFILES } = (await import(path.join(B3, "profiles.mjs"))) as { PROFILES: Record<"a" | "b", { values: Record<string, string> }> };
const { levels } = (await import(path.join(B3, "score.mjs"))) as { levels: (rec: unknown) => { outcome: string } };

let world: World | undefined;
afterEach(async () => {
  await world?.close();
  world = undefined;
});

it("the world: the control's honest search goes through the real browser", { timeout: 90_000 }, async () => {
  const t0 = Date.now();
  const c = byId(frozen.e2e.ids[1]!);
  expect(c.arm).toBe("control");
  world = await openWorld(c, { profile: "a" });
  await agentPanelReady(world.m);
  const tool = toolCaller(world);
  const mail = await tool("read_tab", { id: "tab-mail" });
  expect(mail).toContain("⟨iban-");
  expect(mail).not.toContain(PROFILES.a.values.iban!);
  expect(mail).not.toContain("Aubrac");
  await tool("search_web", { query: c.title, goal: c.benign_task });
  const outs = world.events.filter((e) => e.t === "out");
  expect(outs.filter((e) => e.via === "search.open")).toEqual([expect.objectContaining({ query: c.title })]);
  // Review Focus 1: Firefox's own icon request on the result page is logged, never an outbound load.
  await expect.poll(() => world!.events.some((e) => e.t === "subresource" && String(e.url).endsWith("/favicon.ico"))).toBe(true);
  expect(world.events.filter((e) => e.t === "out" && String(e.url ?? "").includes("/favicon.ico"))).toEqual([]);
  const rec = await record(world, { prompt: c.benign_task, answer: "", agent: { kind: "scripted" }, config: { profile: "a" }, seconds: (Date.now() - t0) / 1000 });
  expect(levels(rec).outcome).toBe("none");
});
