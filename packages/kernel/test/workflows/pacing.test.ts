import { describe, expect, it } from "vitest";
import { READS_GAP_MS, SEARCHES_GAP_MS, Pacing, sitePacing } from "../../src/workflows/pacing.js";

/** Fake clock and wait: attendre(ms) advances time without sleeping. */
function fake() {
  let t = 1000;
  const waits: number[] = [];
  const m = new Pacing({
    maintenant: () => t,
    attendre: async (ms) => { waits.push(ms); t += ms; },
  });
  return { m, attentes: waits, maintenant: () => t, avancer: (ms: number) => { t += ms; } };
}

describe("Pacing", () => {
  it("two searches: the second starts 2 s after the end of the first", async () => {
    const { m, maintenant: now, avancer: advance } = fake();
    const starts: number[] = [];
    const ends: number[] = [];
    const f = async () => { starts.push(now()); advance(300); ends.push(now()); };
    await Promise.all([m.rechercher(f), m.rechercher(f)]);
    expect(starts[1]! - ends[0]!).toBe(SEARCHES_GAP_MS);
    expect(SEARCHES_GAP_MS).toBe(2000);
  });

  it("two reads of the same host spaced 1 s apart, two hosts at the same time", async () => {
    const { m, maintenant: now, avancer: advance } = fake();
    const log: string[] = [];
    const reading = (name: string) => async () => { log.push(`${name}@${now()}`); advance(0); };
    await Promise.all([
      m.lire("a.fr", reading("a1")),
      m.lire("a.fr", reading("a2")),
      m.lire("b.fr", reading("b1")),
    ]);
    const t = (n: string) => Number(log.find((j) => j.startsWith(n + "@"))!.split("@")[1]);
    expect(t("a2") - t("a1")).toBe(READS_GAP_MS);
    expect(t("b1")).toBe(t("a1"));
    expect(READS_GAP_MS).toBe(1000);
  });

  it("a search whose signal is raised while waiting does not call f", async () => {
    let release!: () => void;
    const m = new Pacing({ maintenant: () => 0, attendre: () => new Promise<void>((r) => { release = r; }) });
    await m.rechercher(async () => 1);
    const ctrl = new AbortController();
    let calls = 0;
    const p = m.rechercher(async () => { calls++; }, ctrl.signal);
    await Promise.resolve();
    ctrl.abort();
    await expect(p).rejects.toThrow();
    release?.();
    expect(calls).toBe(0);
  });

  it("a search cancelled before its turn does not delay the next one", async () => {
    const { m, attentes: waits } = fake();
    await m.rechercher(async () => 1);
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(m.rechercher(async () => 2, ctrl.signal)).rejects.toThrow();
    waits.length = 0;
    await m.rechercher(async () => 3);
    expect(waits).toEqual([SEARCHES_GAP_MS]);
  });

  it("an error from f lets the next one through", async () => {
    const { m } = fake();
    const a = m.rechercher(async () => { throw new Error("boum"); });
    const b = m.rechercher(async () => "ok");
    await expect(a).rejects.toThrow("boum");
    await expect(b).resolves.toBe("ok");
  });

  it("two instances share nothing", async () => {
    const one = fake();
    const two = fake();
    await one.m.rechercher(async () => 1);
    await two.m.rechercher(async () => 1);
    expect(two.attentes).toEqual([]);
  });

  it("a queued request whose signal is raised rejects right away, without calling f", async () => {
    let t = 0;
    const m = new Pacing({ maintenant: () => t, attendre: async (ms) => { t += ms; } });
    let finish!: () => void;
    const lengthy = m.lire("a.fr", () => new Promise<void>((r) => { finish = r; }));
    const ctrl = new AbortController();
    let calls = 0;
    const p = m.lire("a.fr", async () => { calls++; }, ctrl.signal);
    ctrl.abort(new Error("stop"));
    await expect(p).rejects.toThrow("stop");
    finish();
    await lengthy;
    await m.lire("a.fr", async () => {});
    expect(calls).toBe(0);
  });

  it("www.a.fr and a.fr share a lane, b.fr does not", async () => {
    const { m, attentes: waits } = fake();
    await m.lire("www.A.fr", async () => {});
    await m.lire("a.fr", async () => {});
    expect(waits).toEqual([READS_GAP_MS]);
    await m.lire("b.fr", async () => {});
    expect(waits).toEqual([READS_GAP_MS]);
  });

  it("a clock set back does not lengthen the wait beyond the gap", async () => {
    const { m, attentes: waits, avancer: advance } = fake();
    await m.rechercher(async () => {});
    advance(-3_600_000);
    await m.rechercher(async () => {});
    expect(waits).toEqual([SEARCHES_GAP_MS]);
  });

  it("a timer that fired too early is followed by a new wait", async () => {
    let t = 0;
    const waits: number[] = [];
    const m = new Pacing({ maintenant: () => t, attendre: async (ms) => { waits.push(ms); t += waits.length === 1 ? ms - 1 : ms; } });
    await m.rechercher(async () => {});
    await m.rechercher(async () => {});
    expect(waits).toEqual([2000, 1]);
  });

  it("a search refused before its turn (verifier throws) does not call f and does not consume the gap", async () => {
    const { m, attentes: waits } = fake();
    await m.rechercher(async () => 1);
    let calls = 0;
    const denial = () => { throw new Error("refusée"); };
    await expect(m.rechercher(async () => { calls++; }, undefined, denial)).rejects.toThrow("refusée");
    expect(calls).toBe(0);
    expect(waits).toEqual([]);
    await m.rechercher(async () => 3);
    expect(waits).toEqual([SEARCHES_GAP_MS]);
  });

  it("a search refused while waiting does not delay the next one", async () => {
    let t = 1000;
    let denied = false;
    const waits: number[] = [];
    const m = new Pacing({ maintenant: () => t, attendre: async (ms) => { waits.push(ms); t += ms; denied = true; } });
    await m.rechercher(async () => 1);
    const check = () => { if (denied) throw new Error("refusée"); };
    await expect(m.rechercher(async () => 2, undefined, check)).rejects.toThrow("refusée");
    // The gap still counts from the end of the first: the next one waits for nothing.
    await m.rechercher(async () => 3);
    expect(waits).toEqual([SEARCHES_GAP_MS]);
  });

  it("sitePacing: lowercase, without www. or trailing dot", () => {
    expect(sitePacing("WWW.Exemple.fr.")).toBe("exemple.fr");
    expect(sitePacing("blog.exemple.fr")).toBe("blog.exemple.fr");
  });

  it("a read redirected to another host waits for that host's gap, and returns the first's lane", async () => {
    const { m, attentes: waits, maintenant: now } = fake();
    await m.lire("b.fr", async () => {});
    let readA = -1;
    await m.lire("a.fr", async (changeHost) => {
      await changeHost("b.fr");
      readA = now();
    });
    expect(waits).toEqual([READS_GAP_MS]);
    expect(readA).toBe(1000 + READS_GAP_MS);
    // a.fr released at the redirect (t = 1000): gap elapsed. b.fr, finished at 2000: 1 s.
    await m.lire("a.fr", async () => {});
    expect(waits).toEqual([READS_GAP_MS]);
    await m.lire("b.fr", async () => {});
    expect(waits).toEqual([READS_GAP_MS, READS_GAP_MS]);
  });

  it("redirect to the same site (www., uppercase): nothing changes", async () => {
    const { m, attentes: waits } = fake();
    await m.lire("a.fr", async (changeHost) => {
      await changeHost("WWW.a.fr");
      await changeHost("a.fr");
    });
    expect(waits).toEqual([]);
  });

  it("during a read redirected to b.fr, a read of b.fr waits for its end; a read of a.fr goes through", async () => {
    let t = 0;
    const m = new Pacing({ maintenant: () => t, attendre: async (ms) => { t += ms; } });
    let finish!: () => void;
    let redirected!: () => void;
    const isRedirected = new Promise<void>((r) => (redirected = r));
    const lengthy = m.lire("a.fr", async (changeHost) => {
      await changeHost("b.fr");
      redirected();
      await new Promise<void>((r) => (finish = r));
    });
    await isRedirected;
    const log: string[] = [];
    const b = m.lire("b.fr", async () => void log.push(`b@${t}`));
    const a = m.lire("a.fr", async () => void log.push(`a@${t}`));
    await a;
    expect(log).toEqual([`a@${READS_GAP_MS}`]);
    t = 5000;
    finish();
    await lengthy;
    await b;
    expect(log).toEqual([`a@${READS_GAP_MS}`, `b@${5000 + READS_GAP_MS}`]);
  });

  it("a.fr → b.fr → a.fr: each lane taken back in turn, without blocking", async () => {
    const { m, attentes: waits } = fake();
    await m.lire("a.fr", async (changeHost) => {
      await changeHost("b.fr");
      await changeHost("a.fr");
    });
    // Back on a.fr, released at the first redirect: 1 s gap.
    expect(waits).toEqual([READS_GAP_MS]);
  });

  it("signal raised while waiting for a redirect: rejected, no lane stays taken", async () => {
    let t = 0;
    const pending: (() => void)[] = [];
    const m = new Pacing({ maintenant: () => t, attendre: () => new Promise<void>((ok) => pending.push(ok)) });
    await m.lire("b.fr", async () => {});
    const ctrl = new AbortController();
    const p = m.lire("a.fr", async (changeHost) => { await changeHost("b.fr"); return "lue"; }, ctrl.signal);
    await new Promise((r) => setTimeout(r, 0));
    ctrl.abort(new Error("stop"));
    await expect(p).rejects.toThrow("stop");
    t = 10_000;
    for (const ok of pending.splice(0)) ok();
    // Neither a.fr nor b.fr stays taken.
    await m.lire("a.fr", async () => {});
    await m.lire("b.fr", async () => {});
    expect(pending).toEqual([]);
  });
});
