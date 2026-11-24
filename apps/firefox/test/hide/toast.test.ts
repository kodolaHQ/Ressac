import { describe, expect, it } from "vitest";
import { endingSentence, toastLine } from "../../core/hide/toast";

// The toast says « Masqué pour l'agent » only when the value is masked on this page; otherwise it says the ending.
describe("toastLine", () => {
  it("hidden: « Masqué pour l'agent » when the hide wrote something, else « Déjà dans votre passeport. »", () => {
    expect(toastLine({ ending: "hidden", created: true, undoable: true })).toBe("chrome-hide-toast");
    expect(toastLine({ ending: "hidden", created: false, undoable: false })).toBe("chrome-hide-toast-already");
  });

  it("any other ending: its own sentence, never « Masqué pour l'agent » nor « Déjà dans votre passeport. »", () => {
    expect(toastLine({ ending: "notHere", created: true, undoable: true })).toBe("chrome-hide-ending-notHere");
    expect(toastLine({ ending: "notHere", created: false, undoable: false })).toBe("chrome-hide-ending-notHere-known");
    expect(toastLine({ ending: "next", created: true, undoable: true })).toBe("chrome-hide-ending-next");
    expect(toastLine({ ending: "agentReached", created: false, undoable: false })).toBe("chrome-hide-ending-agentReached-known");
  });

  it("the chip's sentence: « Ajouté à votre passeport » only for a new entry", () => {
    expect(endingSentence({ ending: "agentReached", created: true })).toBe("chrome-hide-ending-agentReached");
    expect(endingSentence({ ending: "next", created: false })).toBe("chrome-hide-ending-next");
  });
});
