import { expect, test, vi } from "vitest";
import { VIM_KEYS } from "../shared/vim-keys";

// The actor module reads Firefox globals when it loads; its key handling (`run`) needs none of them.
vi.stubGlobal("ChromeUtils", { importESModule: () => ({ setTimeout, clearTimeout }) });
vi.stubGlobal("JSWindowActorParent", class {});
vi.stubGlobal("JSWindowActorChild", class {});
const { WebAiOsVimChild } = await import("../chrome/agent/vim-actor");

/** Runs `keys` on a fresh child whose effects are recorded instead of done; returns the effects, or null if a key was refused. */
function effects(keys: string[]): string[] | null {
  const log: string[] = [];
  const child = new WebAiOsVimChild() as any;
  for (const name of ["scroll", "scrollTo", "showHints", "setPaused", "toggleHelp", "sendAsyncMessage"])
    child[name] = (...args: unknown[]) => {
      log.push(`${name}${JSON.stringify(args)}`);
      return true;
    };
  for (const k of keys) if (!child.run(k, false)) return null;
  return log;
}

/** Every key sequence the actor handles, found by trying every printable key, alone and after another one. */
function handled(): string[] {
  const keys = [...Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)), "Escape"];
  const found = keys.filter((k) => effects([k])?.length);
  for (const a of keys.filter((k) => effects([k])?.length === 0))
    for (const b of keys) {
      const both = effects([a, b]);
      if (both?.length && JSON.stringify(both) !== JSON.stringify(effects([b]))) found.push(a + b);
    }
  return found;
}

test("every key the actor handles is on the cheat sheet; ? opens it", () => {
  const listed = VIM_KEYS.flatMap((g) => g.rows.flatMap((r) => r.keys));
  const found = handled();
  expect(found).toEqual(expect.arrayContaining(["j", "gg", "gS", "yy", "?", "/"]));
  for (const k of found) expect(listed, k).toContain(k);
  expect(listed).toContain("⇧Échap");
  expect(VIM_KEYS.flatMap((g) => g.rows).find((r) => r.keys.includes("?"))?.action).toBe("Afficher cette aide");
  expect(VIM_KEYS.map((g) => g.title)).toEqual(["Défiler", "Naviguer", "Onglets et espaces", "Liens et recherche", "Pause"]);
});
