import { afterEach, describe, expect, it } from "vitest";
import { NO_KERNEL_MESSAGE } from "../host/actions";
import { INVALID_KEY } from "../host/keychain";
import { setHostLocale } from "../host/locale";

describe("host texts follow the shown language", () => {
  afterEach(() => setHostLocale("fr"));
  it("French by default, English once the locale is en, English for an unknown language", () => {
    expect(NO_KERNEL_MESSAGE()).toBe("Le service des actions ne répond pas (agent arrêté ?)");
    setHostLocale("en");
    expect(NO_KERNEL_MESSAGE()).toBe("The actions service is not answering (agent stopped?)");
    expect(INVALID_KEY()).toMatch(/^Invalid key/);
    setHostLocale("xx");
    expect(INVALID_KEY()).toMatch(/^Invalid key/);
  });
});
