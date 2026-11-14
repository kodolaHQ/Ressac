import { expect, test } from "vitest";
import { REVIEW_DURING_OUTAGE } from "../host/extensions/agent";
import { SLOW_SIGNATURE } from "../host/extensions/amo";
import * as messages from "../shared/extensions-messages";

// A person reads these (or the agent relays them word for word): « vous », never « tu ».
const TU = /\b(tu|ton|ta|tes|te)\b|Réessaie|\bréactive\b|\bouvre\b|\binstalle\b/i;

test("user-visible extension messages use « vous »", () => {
  const strings = (Object.values(messages) as unknown[]).filter((m): m is string => typeof m === "string");
  const texts = [SLOW_SIGNATURE, REVIEW_DURING_OUTAGE, ...strings];
  expect(texts.length).toBeGreaterThan(3);
  for (const t of texts) expect(t, t).not.toMatch(TU);
});

test("the dead Chrome Web Store path is gone", async () => {
  expect(await import("../host/extensions/amo")).not.toHaveProperty("STORE_ABSENT");
});
