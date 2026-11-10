import { afterEach, describe, expect, it, vi } from "vitest";
import { AI_ABANDONED } from "../../src/ai/dispatcher.js";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { LocalAi, launchAiProcess, type AiProcess } from "../../src/ai/local-ai.js";
import { tempFolder } from "../helpers/temp.js";
import { fakeRunner, type Response } from "../helpers/fake-runner.js";
import type { Runner } from "../../src/container/runner.js";
import { fakeKev, fakeOllama, fakeSilentOllama, unreachableUrl, type FakeServer } from "../helpers/fake-ai.js";

const COMMIT = "6b719c3c3f367295f6ef336f4f751cf5ff970abc";
const toClose: FakeServer[] = [];
const toStop: LocalAi[] = [];
afterEach(async () => {
  for (const ai of toStop.splice(0)) await ai.stop();
  for (const s of toClose.splice(0)) await s.close();
});
const keep = <T extends FakeServer>(s: T) => (toClose.push(s), s);
const fast = { pollMs: 10, idleCheckMs: 10 };
/** Successful fake git clone: creates the repo in the clone folder. */
const clone = (folder: string) => async (): Promise<Response> => {
  await mkdir(join(folder, "kev.clone-in-progress", ".git"), { recursive: true });
  return { code: 0 };
};

describe("LocalAi", () => {
  it("kev() passes state and questions and returns answers", async () => {
    const kev = keep(await fakeKev());
    const { run: run } = fakeRunner([]);
    const ai = new LocalAi({ folder: await tempFolder(), run: run, kevUrl: kev.url });
    toStop.push(ai);
    const questions = { q: { type: "noul", instructions: "ok ?" } };
    const r = await ai.kev({ state: "texte", questions });
    expect(r).toEqual({ q: { type: "noul", noul: 0.91 } });
    const req = kev.requests.find((x) => x.url === "/v1/systemone")!;
    expect(req.method).toBe("POST");
    expect(req.body).toEqual({ state: "texte", questions });
  });

  it("with modeleDecision, kev() asks Ollama's /v1/systemone with that model and launches nothing", async () => {
    const ollama = keep(await fakeKev());
    const { run: run } = fakeRunner([]);
    const launch = vi.fn();
    const ai = new LocalAi({ folder: await tempFolder(), run: run, launch: launch, ollamaUrl: ollama.url, decisionModel: "pplx-decider-flash" });
    toStop.push(ai);
    const questions = { q: { type: "noul", instructions: "ok ?" } };
    expect(await ai.kev({ state: "texte", questions })).toEqual({ q: { type: "noul", noul: 0.91 } });
    const req = ollama.requests.find((x) => x.url === "/v1/systemone")!;
    expect(req.body).toEqual({ state: "texte", questions, model: "pplx-decider-flash" });
    expect(launch).not.toHaveBeenCalled();
    expect(ai.state().state).not.toBe("not-installed");
  });

  it("an imposed Kev address wins over modeleDecision", async () => {
    const kev = keep(await fakeKev());
    const { run: run } = fakeRunner([]);
    const ai = new LocalAi({ folder: await tempFolder(), run: run, kevUrl: kev.url, ollamaUrl: await unreachableUrl(), decisionModel: "pplx-decider-flash" });
    toStop.push(ai);
    await ai.kev({ state: "texte", questions: {} });
    expect(kev.requests.find((x) => x.url === "/v1/systemone")!.body).toEqual({ state: "texte", questions: {} });
  });

  it("gemma() sends the gemma4:e4b-mlx model, think false, and parses the JSON if requested", async () => {
    const ollama = keep(await fakeOllama('{"a":1}'));
    const { run: run } = fakeRunner([]);
    const ai = new LocalAi({ folder: await tempFolder(), run: run, ollamaUrl: ollama.url });
    expect(await ai.gemma({ prompt: "salut", images: ["QUJD"], json: true })).toEqual({ a: 1 });
    const c = ollama.requests[0]!.body;
    expect(c.model).toBe("gemma4:e4b-mlx");
    expect(c.stream).toBe(false);
    expect(c.think).toBe(false);
    expect(c.keep_alive).toBe("10m");
    expect(c.format).toBe("json");
    expect(c.options).toEqual({ num_ctx: 16384, temperature: 0.2 });
    expect(c.messages[0]).toMatchObject({ role: "user", content: "salut", images: ["QUJD"] });
    expect(await ai.gemma({ prompt: "x" })).toBe('{"a":1}');
    expect(ollama.requests[1]!.body.format).toBeUndefined();
  });

  it("gemma with a raised signal aborts the request to Ollama (fake server)", async () => {
    const ollama = keep(await fakeSilentOllama());
    const { run: run } = fakeRunner([]);
    const ai = new LocalAi({ folder: await tempFolder(), run: run, ollamaUrl: ollama.url });
    const controller = new AbortController();
    const call = ai.gemma({ prompt: "x", json: true, signal: controller.signal });
    await vi.waitFor(() => expect(ollama.requests).toHaveLength(1));
    controller.abort();
    await expect(call).rejects.toThrow(AI_ABANDONED);
    await vi.waitFor(() => expect(ollama.cut()).toBe(1));
    // Already raised: nothing leaves.
    await expect(ai.gemma({ prompt: "y", signal: controller.signal })).rejects.toThrow(AI_ABANDONED);
    expect(ollama.requests).toHaveLength(1);
  });

  it("kev with a raised signal aborts the request to Kev", async () => {
    const kev = keep(await fakeSilentOllama());
    const { run: run } = fakeRunner([]);
    const ai = new LocalAi({ folder: await tempFolder(), run: run, kevUrl: kev.url });
    toStop.push(ai);
    const controller = new AbortController();
    controller.abort();
    await expect(ai.kev({ state: "", questions: {} }, { signal: controller.signal })).rejects.toThrow(AI_ABANDONED);
    expect(kev.requests).toHaveLength(0);
  });

  it("Ollama unreachable: error « Ollama n'est pas lancé »", async () => {
    const { run: run } = fakeRunner([]);
    const ai = new LocalAi({ folder: await tempFolder(), run: run, ollamaUrl: await unreachableUrl() });
    await expect(ai.gemma({ prompt: "x" })).rejects.toThrow("Ollama n'est pas lancé");
  });

  it("Kev absent: « IA locale non installée »", async () => {
    const { run: run } = fakeRunner([]);
    const ai = new LocalAi({ folder: await tempFolder(), run: run, ...fast });
    await expect(ai.kev({ state: "", questions: {} })).rejects.toThrow("IA locale non installée");
    expect(ai.state().state).toBe("not-installed");
  });

  it("without kevUrl, kev() launches the pinned uv command in <folder>/kev, waits for /v1/models, then goes active", async () => {
    const folder = await tempFolder();
    await mkdir(join(folder, "kev", ".git"), { recursive: true });
    const kev = keep(await fakeKev());
    const { run: run } = fakeRunner([]);
    const launches: { cmd: string; args: string[]; cwd: string }[] = [];
    const states: string[] = [];
    let ai!: LocalAi;
    const launch = (cmd: string, args: string[], o: { cwd: string }): AiProcess => {
      launches.push({ cmd, args, cwd: o.cwd });
      // Kev takes a while to answer: we plug it to the fake server's address.
      (ai as any).kevUrl = kev.url;
      return { stop() {}, onOutput() {} };
    };
    ai = new LocalAi({ folder: folder, run: run, launch: launch, port: 8123, onState: (e) => states.push(e), ...fast });
    toStop.push(ai);
    await ai.kev({ state: "", questions: {} });
    expect(launches).toEqual([{
      cmd: "uv",
      args: ["run", "--extra", "serve", "python", "-m", "kev.serve", "--run", "jaredpalmer/kev-4b@v1.0", "--port", "8123"],
      cwd: join(folder, "kev"),
    }]);
    expect(states).toEqual(["starting", "active"]);
    expect(ai.state().state).toBe("active");
  });

  it("Kev dead at startup: « Kev n'a pas démarré : <last lines> »", async () => {
    const folder = await tempFolder();
    await mkdir(join(folder, "kev", ".git"), { recursive: true });
    const { run: run } = fakeRunner([]);
    const launch = (): AiProcess => ({
      stop() {},
      onLine(r) { r("ligne 1"); r("boum"); },
      onOutput(r) { setTimeout(() => r(1), 5); },
    });
    const ai = new LocalAi({ folder: folder, run: run, launch: launch, port: 1, ...fast });
    await expect(ai.kev({ state: "", questions: {} })).rejects.toThrow("Kev n'a pas démarré : ligne 1\nboum");
    expect(ai.state().state).toBe("error");
  });

  it("two calls during startup launch only one process", async () => {
    const folder = await tempFolder();
    await mkdir(join(folder, "kev", ".git"), { recursive: true });
    const kev = keep(await fakeKev());
    const { run: run } = fakeRunner([]);
    let n = 0;
    let ai!: LocalAi;
    const launch = (): AiProcess => {
      n++;
      setTimeout(() => { (ai as any).kevUrl = kev.url; }, 60);
      return { stop() {}, onOutput() {} };
    };
    // port 1: nothing answers there (a real Kev may listen on 8008 during the tests).
    ai = new LocalAi({ folder: folder, run: run, launch: launch, port: 1, ...fast });
    toStop.push(ai);
    await Promise.all([ai.kev({ state: "a", questions: {} }), ai.kev({ state: "b", questions: {} })]);
    expect(n).toBe(1);
    expect(kev.requests.filter((r) => r.url === "/v1/systemone")).toHaveLength(2);
  });

  it("arreter() during startup: state arretee, no error, no timer", async () => {
    const folder = await tempFolder();
    await mkdir(join(folder, "kev", ".git"), { recursive: true });
    const { run: run } = fakeRunner([]);
    let output!: (c: number | null) => void;
    const launch = (): AiProcess => ({
      stop() { setTimeout(() => output(null), 1); },
      onOutput(r) { output = r; },
    });
    const ai = new LocalAi({ folder: folder, run: run, launch: launch, port: 1, ...fast });
    toStop.push(ai);
    const call = ai.kev({ state: "", questions: {} }).catch((e) => e);
    await new Promise((r) => setTimeout(r, 40));
    expect(ai.state().state).toBe("starting");
    await ai.stop();
    await call;
    await new Promise((r) => setTimeout(r, 40));
    expect(ai.state()).toEqual({ state: "stopped" });
    expect((ai as any).timeout).toBeUndefined();
  });

  it("after 10 min without a call, Kev is stopped (fake clock)", async () => {
    const folder = await tempFolder();
    await mkdir(join(folder, "kev", ".git"), { recursive: true });
    const kev = keep(await fakeKev());
    const { run: run } = fakeRunner([]);
    let now = 1000;
    let stopped = 0;
    let ai!: LocalAi;
    const launch = (): AiProcess => {
      (ai as any).kevUrl = kev.url;
      return { stop() { stopped++; }, onOutput() {} };
    };
    ai = new LocalAi({ folder: folder, run: run, launch: launch, clock: () => now, inactivityMs: 600_000, ...fast });
    toStop.push(ai);
    await ai.kev({ state: "", questions: {} });
    expect(ai.state().state).toBe("active");
    now += 599_000;
    await new Promise((r) => setTimeout(r, 50));
    expect(ai.state().state).toBe("active");
    now += 2_000;
    await new Promise((r) => setTimeout(r, 50));
    expect(ai.state().state).toBe("stopped");
    expect(stopped).toBe(1);
  });

  it("arreter() at rest lets Kev be relaunched; fermer() then refuses kev() and gemma() without launching anything", async () => {
    const folder = await tempFolder();
    await mkdir(join(folder, "kev", ".git"), { recursive: true });
    const kev = keep(await fakeKev());
    const ollama = keep(await fakeOllama("ok"));
    const { run: run } = fakeRunner([]);
    let launched = 0;
    let ai!: LocalAi;
    const launch = (): AiProcess => {
      launched++;
      (ai as any).kevUrl = kev.url;
      return { stop() {}, onOutput() {} };
    };
    ai = new LocalAi({ folder: folder, run: run, launch: launch, ollamaUrl: ollama.url, ...fast });
    toStop.push(ai);
    await ai.stop();
    await ai.kev({ state: "", questions: {} });
    expect(launched).toBe(1);
    await ai.stop();
    await ai.kev({ state: "", questions: {} });
    expect(launched).toBe(2);
    await ai.close();
    expect(ai.state().state).toBe("stopped");
    await expect(ai.kev({ state: "", questions: {} })).rejects.toThrow("IA locale fermée");
    await expect(ai.gemma({ prompt: "x" })).rejects.toThrow("IA locale fermée");
    expect(launched).toBe(2);
    expect(ollama.requests).toHaveLength(0);
  });

  it("a kernel's access: once closed, it refuses and stops Kev; another access relaunches Kev", async () => {
    const folder = await tempFolder();
    await mkdir(join(folder, "kev", ".git"), { recursive: true });
    const kev = keep(await fakeKev());
    const { run: run } = fakeRunner([]);
    let launched = 0;
    let stoppedList = 0;
    let ai!: LocalAi;
    const launch = (): AiProcess => {
      launched++;
      (ai as any).kevUrl = kev.url;
      return { stop() { stoppedList++; }, onOutput() {} };
    };
    ai = new LocalAi({ folder: folder, run: run, launch: launch, ...fast });
    toStop.push(ai);
    const first = ai.access();
    await first.kev({ state: "", questions: {} });
    await first.close();
    expect(stoppedList).toBe(1);
    expect(ai.state().state).toBe("stopped");
    // A late harvest of the stopped kernel does not relaunch Kev.
    await expect(first.kev({ state: "", questions: {} })).rejects.toThrow("IA locale fermée");
    await expect(first.gemma({ prompt: "x" })).rejects.toThrow("IA locale fermée");
    expect(launched).toBe(1);
    // The next kernel (other agent profile) has its own access.
    await ai.access().kev({ state: "", questions: {} });
    expect(launched).toBe(2);
  });

  it("installer() chains uv, git clone kev-1.0, uv sync, ollama pull, and resumes a partial install", async () => {
    const folder = await tempFolder();
    const { run: run, calls: calls } = fakeRunner([
      [/^uv --version/, { code: 0, stdout: "uv 0.5\n" }],
      [/^git clone/, clone(folder)],
      [/rev-parse HEAD/, { code: 0, stdout: COMMIT + "\n" }],
      [/^ollama pull/, { code: 0, stdout: "pulling…\nsuccess\n" }],
    ]);
    const ai = new LocalAi({ folder: folder, run: run });
    const lines: string[] = [];
    await ai.install((l) => lines.push(l));
    const cmds = calls.map((a) => [a.command, ...a.args].join(" "));
    expect(cmds[0]).toBe("uv --version");
    // Cloned alongside then renamed: an interrupted clone never leaves a half-filled `kev/.git`.
    expect(cmds[1]).toBe(`git clone --depth 1 --branch kev-1.0 https://github.com/jaredpalmer/kev.git ${join(folder, "kev.clone-in-progress")}`);
    expect(existsSync(join(folder, "kev", ".git"))).toBe(true);
    expect(existsSync(join(folder, "kev.clone-in-progress"))).toBe(false);
    expect(cmds.some((c) => c.includes("rev-parse HEAD"))).toBe(true);
    expect(cmds.findIndex((c) => c.startsWith("uv sync --extra serve"))).toBeGreaterThan(1);
    expect(cmds.at(-1)).toBe("ollama pull gemma4:e4b-mlx");
    expect(lines).toContain("success");
    expect(calls.find((a) => a.args[0] === "sync")!.args).toEqual(["sync", "--extra", "serve", "--project", join(folder, "kev")]);

    // resume: the repo is already there, no new clone
    const second = fakeRunner([
      [/^uv --version/, { code: 0 }],
      [/rev-parse HEAD/, { code: 0, stdout: COMMIT }],
    ]);
    await new LocalAi({ folder: folder, run: second.run }).install(() => {});
    expect(second.calls.some((a) => a.command === "git" && a.args[0] === "clone")).toBe(false);
    expect(second.calls.some((a) => a.args[0] === "sync")).toBe(true);
  });

  it("installer() refuses without uv, and refuses an unexpected commit", async () => {
    const withoutUv = fakeRunner([[/^uv --version/, { code: 127 }]]);
    await expect(new LocalAi({ folder: await tempFolder(), run: withoutUv.run }).install(() => {}))
      .rejects.toThrow("installe uv : brew install uv");
    const folder = await tempFolder();
    const wrong = fakeRunner([[/^git clone/, clone(folder)], [/rev-parse HEAD/, { code: 0, stdout: "deadbeef\n" }]]);
    await expect(new LocalAi({ folder: folder, run: wrong.run }).install(() => {}))
      .rejects.toThrow(/commit/);
  });
});

describe("LocalAi : quitter annule l'installation", () => {
  /** Fake git clone that stays in progress (partial files written) until cancellation; `ignorer`: deaf to the signal. */
  function endlessClone(folder: string, ignore = false) {
    const received: (AbortSignal | undefined)[] = [];
    let started!: () => void;
    const running = new Promise<void>((ok) => (started = ok));
    const run: Runner = async (command, args, opts) => {
      if (command === "uv" && args[0] === "--version") return { code: 0, stdout: "uv 0.5", stderr: "" };
      if (command === "git" && args[0] === "clone") {
        received.push(opts?.signal);
        await mkdir(join(args.at(-1)!, ".git"), { recursive: true });
        await writeFile(join(args.at(-1)!, ".git", "pack-partiel"), "à moitié");
        started();
        return new Promise((ok) => {
          if (!ignore) opts?.signal?.addEventListener("abort", () => ok({ code: 143, stdout: "", stderr: "tué" }));
        });
      }
      throw new Error(`appel inattendu : ${command} ${args.join(" ")}`);
    };
    return { run: run, received: received, running: running };
  }

  it("fermer() during the clone: the process receives the cancellation, nothing else is launched, the partial clone is erased, then a new install restarts cleanly", async () => {
    const folder = await tempFolder();
    const fake = endlessClone(folder);
    const ai = new LocalAi({ folder: folder, run: fake.run });
    const installation = ai.install(() => {});
    await fake.running;
    await ai.close();
    await expect(installation).rejects.toThrow("Installation annulée");
    expect(fake.received[0]?.aborted).toBe(true);
    expect(existsSync(join(folder, "kev"))).toBe(false);
    expect(existsSync(join(folder, "kev.clone-in-progress"))).toBe(false);
    await expect(ai.install(() => {})).rejects.toThrow("IA locale fermée");

    // Next launch: new LocalAi, the install restarts from the beginning.
    const { run: run, calls: calls } = fakeRunner([
      [/^git clone/, clone(folder)],
      [/rev-parse HEAD/, { code: 0, stdout: COMMIT }],
    ]);
    await new LocalAi({ folder: folder, run: run }).install(() => {});
    expect(calls.some((a) => a.command === "git" && a.args[0] === "clone")).toBe(true);
    expect(calls.at(-1)!.command).toBe("ollama");
    expect(existsSync(join(folder, "kev", ".git"))).toBe(true);
  });

  it("each install command receives the cancellation signal (uv sync, ollama pull)", async () => {
    const folder = await tempFolder();
    await mkdir(join(folder, "kev", ".git"), { recursive: true });
    let pull: AbortSignal | undefined;
    const fake = fakeRunner([
      [/rev-parse HEAD/, { code: 0, stdout: COMMIT }],
    ]);
    const run: Runner = (c, a, o) => {
      if (c === "ollama") {
        pull = o?.signal;
        return new Promise((ok) => o?.signal?.addEventListener("abort", () => ok({ code: 143, stdout: "", stderr: "" })));
      }
      return fake.run(c, a, o);
    };
    const ai = new LocalAi({ folder: folder, run: run });
    const installation = ai.install(() => {});
    while (!pull) await new Promise((r) => setTimeout(r, 5));
    expect(fake.calls.find((a) => a.args[0] === "sync")!.opts?.signal).toBe(pull);
    await ai.close();
    await expect(installation).rejects.toThrow("Installation annulée");
    expect(pull.aborted).toBe(true);
  });

  it("fermer() does not wait beyond the delay for a process that ignores the cancellation; the rest of the clone is erased at the next launch", async () => {
    const folder = await tempFolder();
    const fake = endlessClone(folder, true);
    const ai = new LocalAi({ folder: folder, run: fake.run, cancelDelayMs: 50 });
    void ai.install(() => {}).catch(() => {});
    await fake.running;
    const start = Date.now();
    await ai.close();
    expect(Date.now() - start).toBeLessThan(1000);
    expect(existsSync(join(folder, "kev.clone-in-progress", ".git"))).toBe(true); // the deaf process still holds its files

    const seenByClone: boolean[] = [];
    const { run: run } = fakeRunner([
      [/^git clone/, async () => {
        seenByClone.push(existsSync(join(folder, "kev.clone-in-progress")));
        return clone(folder)();
      }],
      [/rev-parse HEAD/, { code: 0, stdout: COMMIT }],
    ]);
    await new LocalAi({ folder: folder, run: run }).install(() => {});
    expect(seenByClone).toEqual([false]); // the rest was erased before recloning
    expect(existsSync(join(folder, "kev", ".git", "pack-partiel"))).toBe(false);
  });
});

describe("launchAiProcess (Kev: uv launches a Python child)", () => {
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const waitUntilTrue = async (f: () => boolean, ms = 5000) => {
    const end = Date.now() + ms;
    while (!f() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    return f();
  };
  /** Launches `sh -c script`; the script writes its child's pid on the first line. */
  async function launchWithChild(script: string, killDelayMs?: number) {
    const p = launchAiProcess("sh", ["-c", script], { cwd: process.cwd(), ...(killDelayMs ? { killDelayMs: killDelayMs } : {}) });
    const pid = await new Promise<number>((ok) => p.onLine?.((l) => ok(Number(l))));
    let exited = false;
    p.onOutput(() => (exited = true));
    return { p, pid, exited: () => exited };
  }

  it("arreter() also kills the children (the whole group), not only the first process", async () => {
    const { p, pid, exited: exited } = await launchWithChild("sleep 300 & echo $!; wait");
    expect(alive(pid)).toBe(true);
    p.stop();
    expect(await waitUntilTrue(() => !alive(pid))).toBe(true);
    expect(await waitUntilTrue(exited)).toBe(true);
  });

  it("a group that ignores SIGTERM is killed by SIGKILL after the delay", async () => {
    const { p, pid } = await launchWithChild("trap '' TERM; sleep 300 & echo $!; wait", 200);
    p.stop();
    await new Promise((r) => setTimeout(r, 100));
    expect(alive(pid)).toBe(true); // SIGTERM ignored
    expect(await waitUntilTrue(() => !alive(pid))).toBe(true);
  });
});
