import { expect, it } from "vitest";
import { passportTip, uncoveredText } from "../ui/components/maskBanner";
import { passportShown } from "../chrome/passport/store";
import { format } from "../shared/i18n";
import { maskedDisplay } from "../chrome/shims/kernel";

const t = (id: string) => format("fr", id);
// Built from parts: no whole personal value in the source.
const FAMILY = ["Aub", "rac"].join("");
const STREET = ["Tann", "eurs"].join("");

it("the « non couverte » banner: the step-1 text for a resumed conversation, the passport text for an addition only", () => {
  expect(uncoveredText({ uncovered: true, uncoveredPassport: [{ profile: "p", id: "a" }] })).toBe("agent-mask-uncovered");
  expect(uncoveredText({ uncovered: false, uncoveredPassport: [{ profile: "p", id: "a" }] })).toBe("agent-mask-uncovered-passport");
  expect(uncoveredText({ uncovered: false, uncoveredPassport: [] })).toBeNull();
  expect(t("agent-mask-uncovered-passport")).toBe(
    "Cette conversation a peut-être lu en clair une valeur que vous avez ajoutée depuis à votre passeport : l'agent peut la connaître. Tout le reste est toujours masqué.",
  );
});

it("the tooltip names each added entry by its card name and masked display, never its value; a removed one generically", () => {
  const created = "2026-11-23T10:00:00.000Z";
  const base = { variants: [], origins: [], how: "typed" as const, created, updated: created };
  const entries = [
    { ...base, id: "a", field: "adresse" as const, value: { text: `14 rue des ${STREET}\n69005 Lyon` } },
    { ...base, id: "n", field: "nom" as const, value: { given: "Camille", family: FAMILY } },
  ];
  // The files' cache of the last good load, as store.ts keeps it: field and masked display only.
  const shownEntry = (_: string, id: string) => {
    const e = entries.find((x) => x.id === id);
    return e ? { field: e.field, display: maskedDisplay(e) } : null;
  };
  const tip = passportTip(passportShown({ shownEntry }, [{ profile: "p", id: "a" }, { profile: "p", id: "n" }, { profile: "p", id: "gone" }]), t);
  const lines = tip.split("\n");
  expect(lines[0]).toMatch(/^votre adresse · •• r•• d•• T•+/);
  expect(lines[1]).toMatch(/^votre nom · C•+ A•+$/);
  expect(lines[2]).toBe("une valeur de votre passeport");
  for (const clear of [FAMILY, STREET, "Camille", "14 rue", "69005", "Lyon"]) expect(tip).not.toContain(clear);
});
