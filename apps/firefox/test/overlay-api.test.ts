import vm from "node:vm";
import { describe, expect, it } from "vitest";
import type { OverlayApi, OverlayContext } from "../shared/api";
import { overlayApi, type DesignService } from "../chrome/store/design";
import { INVALID_REQUEST, REMARK_TEXT_MAX } from "../shared/design-guards";
import { wrapOverlayApi } from "../ui/overlay-api";

const T = { type: "fenetre" as const, fenetreId: "F" };
const ctx = (mode: OverlayContext["mode"], projet: string): OverlayContext => ({
  mode, message: null, projet, etiquette: "input#email.champ", source: null, destination: "l'agent", sansDestination: null, avertissement: null,
});

/** A fake service (its overlay showing `shown`) and host; every call noted. */
function setup(shown: Partial<Record<OverlayContext["mode"], OverlayContext>> = { bulle: ctx("bulle", "demo-15308") }) {
  const calls: string[] = [];
  const design = {
    overlayContext: (_t, modes = ["bulle", "panier", "message"]) => modes.map((m) => shown[m]).find(Boolean) ?? null,
    add: async (_t, texte) => (calls.push(`add:${texte.length}`), { ok: true }),
    cancel: () => void calls.push("cancel"),
    onChange: () => () => {},
  } as Partial<DesignService> as DesignService;
  const host = {
    request: async <T>(method: string, params?: unknown): Promise<T> => (calls.push(`${method} ${JSON.stringify(params)}`), (method === "design.envoyer" ? { ok: true } : []) as T),
    on: () => () => {},
  };
  return { design, host, calls };
}

describe("overlayApi", () => {
  it("the overlay API bounds the remark: 4,001 characters refused without a call (Demande invalide), 4,000 passes", async () => {
    const { design, host, calls } = setup();
    const api = overlayApi({ design, host }, T);
    expect(await api.ajouter("x".repeat(REMARK_TEXT_MAX + 1))).toEqual({ ok: false, erreur: INVALID_REQUEST });
    expect(await api.ajouter(42 as unknown as string)).toEqual({ ok: false, erreur: INVALID_REQUEST });
    expect(calls).toEqual([]);
    expect(await api.ajouter("x".repeat(REMARK_TEXT_MAX))).toEqual({ ok: true });
    expect(calls).toEqual(["add:4000"]);
  });

  it("projetPermis: only the project the overlay shows reaches the host; another one gets [], nothing or Demande invalide", async () => {
    const { design, host, calls } = setup();
    const api = overlayApi({ design, host }, T);
    expect(await api.panier("demo-1")).toEqual([]);
    expect(await api.lots("app-autre")).toEqual([]);
    await api.retirer("demo-1", "e1");
    await api.traite("demo-1", "l1");
    expect(await api.envoyer("demo-1")).toEqual({ ok: false, erreur: INVALID_REQUEST });
    // A bad id for the right project, too.
    await api.retirer("demo-15308", "x".repeat(65));
    expect(calls).toEqual([]);
    await api.panier("demo-15308");
    await api.retirer("demo-15308", "e1");
    expect(await api.envoyer("demo-15308")).toEqual({ ok: true });
    expect(calls).toEqual(['design.panier {"projet":"demo-15308"}', 'design.retirer {"projet":"demo-15308","id":"e1"}', 'design.envoyer {"projet":"demo-15308"}']);
  });

  it("spec §5.10 the host stopped: the cart and batches last read stand; never read, the rejection passes; its restart reads again", async () => {
    const { design } = setup();
    let down = false;
    const on: string[] = [];
    const host = {
      request: async <T>(method: string): Promise<T> => {
        if (down) throw new Error("hôte arrêté");
        return (method === "design.panier" ? [{ id: "e1" }] : [{ id: "l1" }]) as T;
      },
      on: (m: string) => (on.push(m), () => {}),
    };
    const api = overlayApi({ design, host }, T);
    expect(await api.panier("demo-15308")).toEqual([{ id: "e1" }]);
    down = true;
    expect(await api.panier("demo-15308")).toEqual([{ id: "e1" }]);
    await expect(api.lots("demo-15308")).rejects.toThrow("hôte arrêté");
    api.surChange(() => {});
    expect(on).toEqual(["design.change", "accueil.change"]);
  });

  it("a message (project '') allows no cart at all", async () => {
    const { design, host, calls } = setup({ message: ctx("message", "") });
    expect(await overlayApi({ design, host }, T).panier("")).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("each frame reads its own modes; the column's annuler is its own", async () => {
    const { design, host, calls } = setup({ bulle: ctx("bulle", "demo-15308"), panier: ctx("panier", "demo-15308") });
    let closed = 0;
    const column = overlayApi({ design, host, modes: ["panier"], annuler: () => closed++ }, T);
    const calque = overlayApi({ design, host, modes: ["bulle", "message"] }, T);
    expect((await column.contexte())?.mode).toBe("panier");
    expect((await calque.contexte())?.mode).toBe("bulle");
    column.annuler();
    expect([closed, calls]).toEqual([1, []]);
    calque.annuler();
    expect(calls).toEqual(["cancel"]);
  });
});

describe("wrapOverlayApi", () => {
  const foreign = vm.runInNewContext("({ Error, value: { a: [1] } })") as { Error: ErrorConstructor; value: { a: number[] } };
  const raw = (o: Partial<OverlayApi>) => ({ ...o }) as OverlayApi;

  it("an answer is a copy, never the chrome's object", async () => {
    const shown = ctx("bulle", "demo-15308");
    const api = wrapOverlayApi(raw({ contexte: async () => shown, panier: async () => foreign.value as never }), (f) => f);
    const c = await api.contexte();
    expect(c).toEqual(shown);
    expect(c).not.toBe(shown);
    const p = (await api.panier("demo-15308")) as unknown as { a: number[] };
    expect(p).not.toBe(foreign.value);
    expect(Object.getPrototypeOf(p)).toBe(Object.prototype);
  });

  it("a rejection is an Error of the caller's realm, with its message; a throw too", async () => {
    const api = wrapOverlayApi(
      raw({
        envoyer: () => Promise.reject(new foreign.Error("hôte arrêté")),
        lots: () => {
          throw new foreign.Error("cassé");
        },
      }),
      (f) => f,
    );
    const e = await api.envoyer("demo-15308").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(Error);
    expect((e as Error).message).toBe("hôte arrêté");
    const e2 = await api.lots("demo-15308").catch((x: unknown) => x);
    expect(e2).toBeInstanceOf(Error);
    expect((e2 as Error).message).toBe("cassé");
  });

  it("listeners are removed when the frame unloads", () => {
    let off = 0;
    let unload: (() => void) | undefined;
    const api = wrapOverlayApi(raw({ surChange: () => () => void off++ }), (f) => ((unload = f), f));
    api.surChange(() => {});
    expect(off).toBe(0);
    unload!();
    expect(off).toBe(1);
  });
});
