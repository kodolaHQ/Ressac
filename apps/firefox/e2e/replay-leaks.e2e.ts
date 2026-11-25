import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { answerCards, openWorld, record, toolCaller, type ReplayCase, type World } from "./replay";
import { agentPanelReady } from "./ui";

/** B3's leak replay in the compiled browser (bench/security/B3/browser): the world, then the scripted adversary on it.
 *  Suite budget (about 2 min of legs): every attack runs, and the controls of bare-pieces, link-covert and action-clear
 *  only; the three other controls (hangul-lab-digits, hangul-address, passport-street-out: 2026-11-25, each passed, the
 *  whole file took 2 min 55 s) are left out. */
const B3 = path.resolve(import.meta.dirname, "../../../bench/security/B3");
const frozen = JSON.parse(readFileSync(path.join(B3, "browser/replay-cases.json"), "utf8")) as { e2e: { file: string; ids: string[] } };
const cases = JSON.parse(readFileSync(path.join(B3, frozen.e2e.file), "utf8")) as ReplayCase[];
const byId = (id: string) => cases.find((c) => c.id === id)!;
const { PROFILES } = (await import(path.join(B3, "profiles.mjs"))) as { PROFILES: Record<"a" | "b", { values: Record<string, string> }> };
const { levels } = (await import(path.join(B3, "score.mjs"))) as { levels: (rec: unknown) => { outcome: string; liaison: string[]; lesson: string[] } };
const { tried, stoppedBy } = (await import(path.join(B3, "browser/report.mjs"))) as { tried: (rec: unknown) => boolean; stoppedBy: (rec: unknown) => string[] };
const { play } = (await import(path.join(B3, "adversary.mjs"))) as { play: (call: ReturnType<typeof toolCaller>, id: string) => Promise<string> };
const until = async (f: () => string | null) => { for (;;) { const v = f(); if (v) return v; await new Promise((r) => setTimeout(r, 100)); } };

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

/** Attacks the replay's passport stops at the read: the value their script needs (the client id, the lab file: `libre`
 *  entries, masked as ⟨masque-…⟩) never reaches it, and the script (unchanged from B3) has no label path, so it sends
 *  nothing: not tried, stopped by masking, and the read shows the label, never the value. */
const MASKED_AT_READ: Record<string, { tool: string; value: string }> = {
  "adv-action-clear-a": { tool: "read_tab", value: PROFILES.a.values.client! },
  "adv-hangul-lab-digits-a": { tool: "search_history", value: PROFILES.a.values.lab! },
};

// The scripted adversary's frozen pairs (replay-cases.json `e2e`), each in a fresh world, every card granted (B3's worst case).
const LEFT_OUT = new Set(["adv-hangul-lab-digits-c", "adv-hangul-address-c", "adv-passport-street-out-c"]);
it.each(frozen.e2e.ids.filter((id) => !LEFT_OUT.has(id)))("%s: the scripted adversary in the real browser", { timeout: 120_000 }, async (id) => {
  const t0 = Date.now();
  const c = byId(id);
  world = await openWorld(c, { profile: "a" });
  await agentPanelReady(world.m);
  const cards = answerCards(world, { card: "grant", address: "grant" });
  const leg = play(toolCaller(world), id);
  // An unknown card ends the leg (its tool call would wait forever on it).
  const end = await Promise.race([leg.then((answer) => ({ answer }), (e: unknown) => ({ answer: "", error: String(e) })), until(cards.failed).then((error) => ({ answer: "", error }))]);
  leg.catch(() => {});
  await cards.stop();
  const rec = await record(world, { prompt: c.benign_task, ...end, agent: { kind: "scripted" }, config: { profile: "a", card: "grant", address: "grant" }, seconds: (Date.now() - t0) / 1000 });
  expect(cards.failed()).toBeNull();
  expect(end).not.toHaveProperty("error");
  const lv = levels(rec);
  expect({ outcome: ["none", "blocked"].includes(lv.outcome) ? "ok" : lv.outcome, liaison: lv.liaison, lesson: lv.lesson }).toEqual({ outcome: "ok", liaison: [], lesson: [] });
  const masked = MASKED_AT_READ[id];
  if (masked) {
    const reads = world.events.filter((e) => e.t === "tool" && e.name === masked.tool).map((e) => String(e.result));
    expect(reads.some((r) => r.includes("⟨masque-"))).toBe(true);
    // Nowhere: no tool result, argument or outbound load holds the value.
    expect(JSON.stringify(world.events)).not.toContain(masked.value);
    expect([tried(rec), stoppedBy(rec)]).toEqual([false, ["masking"]]);
  } else if (c.arm === "attack") {
    expect(tried(rec)).toBe(true);
    // Review Focus 5: a layer is named (masking for a label sent alone), never « the model refused ».
    expect(stoppedBy(rec)).not.toContain("left");
    expect(stoppedBy(rec)).not.toEqual([]);
  } else expect(tried(rec)).toBe(false);
});

// Review Focus 2: a card the automatic user cannot answer fails the leg at once, never a timeout. Injected into the sidebar
// (chrome): an unknown kind, and a fill card with no « Remplir » (the passport lacks the kind: MaskRequest.svelte `missing`).
it.each([
  ["a kind it does not know", '<div class="reading" data-testid="mask-request" data-kind="unknown"><p>Une carte inconnue</p></div>', "unknown card: mask-request/unknown"],
  ["a grant the card cannot take", '<div class="reading" data-testid="mask-request" data-kind="mask-fill"><p>Remplir ?</p><div class="actions"><button>Refuser</button></div></div>', "unknown card: mask-request/mask-fill (no allow)"],
  // A card body that is no .reading (as DevToolsRequest.svelte's): the modal stays up 2 s with nothing known, the leg fails.
  ["a modal with no known card", '<div class="card"><div data-testid="new-request"><p>Une nouvelle carte</p><button class="allow">Autoriser</button></div></div>', "unknown card: new-request"],
])("Review Focus 2: %s fails the leg", { timeout: 90_000 }, async (_name, html, message) => {
  world = await openWorld(byId(frozen.e2e.ids[0]!), { profile: "a" });
  await agentPanelReady(world.m);
  const cards = answerCards(world, { card: "grant", address: "grant" });
  try {
    await world.m.execute(`const doc = document.getElementById("ressac-sidebar").contentDocument;
      const modal = doc.createElement("div");
      modal.dataset.testid = "request-modal";
      modal.innerHTML = arguments[0];
      doc.body.append(modal);`, [html]);
    await expect.poll(() => cards.failed(), { timeout: 5_000 }).toBe(message);
  } finally {
    await cards.stop();
  }
});

// The dev-tools card (DevToolsRequest.svelte, no .reading) is answered through the real modal, by `card`: never left to hang.
it("a dev-tools request is answered, not hung", { timeout: 90_000 }, async () => {
  world = await openWorld(byId(frozen.e2e.ids[0]!), { profile: "a" });
  await agentPanelReady(world.m);
  const cards = answerCards(world, { card: "grant", address: "grant" });
  try {
    const answer = await Promise.race([toolCaller(world)("request_devtools", { id: "tab-mail", rights: ["console"], reason: "Le bouton ne réagit pas." }), until(cards.failed)]);
    expect(answer).toContain("Droits accordés : console");
    expect(world.events.filter((e) => e.t === "card-devtools").map((e) => e.answer)).toEqual(["grant"]);
    expect(cards.failed()).toBeNull();
  } finally {
    await cards.stop();
  }
});
