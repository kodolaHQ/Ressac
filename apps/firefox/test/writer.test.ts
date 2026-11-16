import { describe, expect, it } from "vitest";
import { createWriterChoice } from "../host/writer";

const setup = (state: string, loggedIn: Record<string, boolean>, preferred: "claude" | "codex" = "claude") => {
  const calls: string[] = [];
  let t = 0;
  const choice = createWriterChoice({
    workshop: {
      state: async () => state as never,
      exec: async (argv) => {
        calls.push(argv[0]!);
        const a = argv[0]!;
        return a === "claude"
          ? { code: 0, stdout: JSON.stringify({ loggedIn: loggedIn.claude }), stderr: "" }
          : { code: 0, stdout: loggedIn.codex ? "Logged in using ChatGPT" : "Not logged in", stderr: "" };
      },
    },
    preferred: () => preferred,
    now: () => t,
  });
  return { choice, calls, advance: (ms: number) => (t += ms) };
};

describe("writer choice", () => {
  it("takes the preferred agent when signed in", async () => {
    expect(await setup("demarre", { claude: true, codex: true }).choice.agent()).toBe("claude");
  });
  it("falls back to the other agent", async () => {
    expect(await setup("demarre", { claude: false, codex: true }).choice.agent()).toBe("codex");
  });
  it("is null when both are signed out", async () => {
    expect(await setup("demarre", {}).choice.agent()).toBeNull();
  });
  it("is null without exec when the workshop is not running", async () => {
    const s = setup("arrete", { claude: true });
    expect(await s.choice.agent()).toBeNull();
    expect(s.calls).toEqual([]);
  });
  it("caches 5 minutes, then reset or signedOut check again", async () => {
    const s = setup("demarre", { claude: true });
    await s.choice.agent();
    await s.choice.agent();
    expect(s.calls).toEqual(["claude"]);
    s.choice.reset();
    await s.choice.agent();
    s.choice.signedOut("claude");
    await s.choice.agent();
    expect(s.calls).toHaveLength(3);
    s.advance(5 * 60_000 + 1);
    await s.choice.agent();
    expect(s.calls).toHaveLength(4);
  });
});
