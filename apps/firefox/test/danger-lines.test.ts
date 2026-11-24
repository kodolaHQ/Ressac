import { expect, test } from "vitest";
import { dangerLines, DANGER_LINES_MAX } from "../ui/components/danger-lines";
import { UNLOCK_REASON_LENGTH } from "../shared/extensions-messages";

test("every line of a card's danger is kept, past five, in order", () => {
  const lines = Array.from({ length: 7 }, (_, i) => `ligne ${i}`);
  expect(dangerLines(lines.join("\n"))).toEqual(lines);
  expect(dangerLines(Array.from({ length: 60 }, () => "x").join("\n"))).toHaveLength(DANGER_LINES_MAX);
});

test("each line is bounded on its own: a long handle line never cuts the lock line after it", () => {
  const long = `Cette adresse contient votre e-mail, lue sur ${"suivi-colis.".repeat(30)}example`;
  const lock = "Conversation verrouillée : votre code a été révélé. Cette sortie demande votre accord.";
  const shown = dangerLines(`${long}\n${lock}`);
  expect(shown[0]).toHaveLength(UNLOCK_REASON_LENGTH);
  expect(shown[1]).toBe(lock);
  expect(dangerLines(undefined)).toEqual([]);
});
