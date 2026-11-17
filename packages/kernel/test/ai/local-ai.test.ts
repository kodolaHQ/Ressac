import { afterEach, describe, expect, it, vi } from "vitest";
import { AI_ABANDONED } from "../../src/ai/dispatcher.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { LocalAi, D1_FILE } from "../../src/ai/local-ai.js";
import { EMBED_MODEL, type AiProcess } from "../../src/ai/llama-model.js";
import { D1_ANCHORS, toPplxScale } from "../../src/ai/d1-scale.js";
import { tempFolder } from "../helpers/temp.js";
import { fakeForeign, fakeKev, fakeOllama, fakeSilentServer, type FakeServer } from "../helpers/fake-ai.js";

const toClose: FakeServer[] = [];
const toStop: LocalAi[] = [];
afterEach(async () => {
  for (const ai of toStop.splice(0)) await ai.stop();
  for (const s of toClose.splice(0)) await s.close();
});
const keep = <T extends FakeServer>(s: T) => (toClose.push(s), s);
const fast = { pollMs: 10, idleCheckMs: 10 };
const LLAMA = "/opt/llama/llama-server";
/** A folder where the d1 model is already downloaded. */
async function installed(): Promise<string> {
  const folder = await tempFolder();
  await mkdir(join(folder, "d1"), { recursive: true });
  await writeFile(join(folder, "d1", D1_FILE), "gguf");
  return folder;
}
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** Fake model host: /model answers with a 302 to /file, which honours `Range: bytes=N-`; `hold` stops after half the bytes and never ends. */
async function fakeFile(data: Buffer, o: { hold?: boolean } = {}) {
  const headers: IncomingHttpHeaders[] = [];
  const open: ServerResponse[] = [];
  const server = createServer((req, res) => {
    if (req.url === "/model") {
      res.writeHead(302, { location: "/file" });
      return res.end();
    }
    headers.push(req.headers);
    const m = /^bytes=(\d+)-$/.exec(req.headers.range ?? "");
    const from = m ? Number(m[1]) : 0;
    res.writeHead(m ? 206 : 200, { "content-length": data.length - from, ...(m ? { "content-range": `bytes ${from}-${data.length - 1}/${data.length}` } : {}) });
    if (!o.hold) return res.end(data.subarray(from));
    res.write(data.subarray(from, data.length / 2));
    open.push(res);
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  return keep({
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/model`,
    requests: [],
    headers,
    close: () => new Promise<void>((ok) => { open.forEach((r) => r.destroy()); server.closeAllConnections(); server.close(() => ok()); }),
  });
}

describe("LocalAi", () => {
  it("kev() passes state and questions to the forced address and maps the answers onto pplx's scale", async () => {
    const kev = keep(await fakeKev());
    const ai = new LocalAi({ folder: await tempFolder(), kevUrl: kev.url });
    toStop.push(ai);
    const questions = { q: { type: "noul", instructions: "ok ?" } };
    const r = await ai.kev({ state: "texte", questions });
    expect(r).toEqual(toPplxScale({ q: { type: "noul", noul: 0.91 } }));
    const req = kev.requests.find((x) => x.url === "/v1/systemone")!;
    expect(req.method).toBe("POST");
    expect(req.body).toEqual({ state: "texte", questions });
  });

  it("maps the noul answer", async () => {
    const kev = keep(await fakeKev({ q: { noul: D1_ANCHORS[2]![0] } }));
    const ai = new LocalAi({ folder: await tempFolder(), kevUrl: kev.url });
    toStop.push(ai);
    expect(await ai.kev({ state: "", questions: {} })).toEqual({ q: { noul: D1_ANCHORS[2]![1] } });
  });

  it("check reports decision from the file", async () => {
    expect(await new LocalAi({ folder: await tempFolder() }).check()).toEqual({ decision: false, embed: false });
    expect((await new LocalAi({ folder: await installed() }).check()).decision).toBe(true);
    expect((await new LocalAi({ folder: await tempFolder(), kevUrl: "http://127.0.0.1:9" }).check()).decision).toBe(true);
  });

  it("check reports the search model from its own file in embed/", async () => {
    const folder = await tempFolder();
    const ai = new LocalAi({ folder });
    expect((await ai.check()).embed).toBe(false);
    await mkdir(join(folder, "embed"), { recursive: true });
    await writeFile(join(folder, "embed", EMBED_MODEL.file), "gguf");
    expect((await ai.check()).embed).toBe(true);
    expect(ai.embed.installed()).toBe(true);
  });

  it("a folder left by an older Ressac (Gemma, its own Ollama) loads: check works and no call reaches Ollama", async () => {
    const ollama = keep(await fakeOllama('{"a":1}', ["gemma4:e4b-mlx"]));
    const folder = await installed();
    await mkdir(join(folder, "kev"), { recursive: true });
    const before = process.env.RESSAC_OLLAMA_URL;
    process.env.RESSAC_OLLAMA_URL = ollama.url;
    try {
      const ai = new LocalAi({ folder });
      expect(await ai.check()).toEqual({ decision: true, embed: false });
      await expect(ai.access().gemma({ prompt: "x" })).rejects.toThrow("Connect Claude Code or Codex");
      expect(ollama.requests).toHaveLength(0);
    } finally {
      if (before === undefined) delete process.env.RESSAC_OLLAMA_URL;
      else process.env.RESSAC_OLLAMA_URL = before;
    }
  });

  it("access().gemma goes to the writer, and is refused once the access is closed", async () => {
    const writer = vi.fn().mockResolvedValue({ a: 1 });
    const ai = new LocalAi({ folder: await tempFolder(), writer });
    const access = ai.access();
    expect(await access.gemma({ prompt: "p", json: true })).toEqual({ a: 1 });
    expect(writer).toHaveBeenCalledWith({ prompt: "p", json: true, images: undefined, signal: undefined });
    await access.close();
    await expect(access.gemma({ prompt: "p" })).rejects.toThrow("IA locale fermée");
    expect(writer).toHaveBeenCalledTimes(1);
  });

  it("without a writer, gemma() rejects with the writer's no-account error", async () => {
    const ai = new LocalAi({ folder: await tempFolder(), locale: () => "fr" });
    await expect(ai.gemma({ prompt: "x" })).rejects.toThrow("Connectez Claude Code ou Codex");
    await expect(ai.access().gemma({ prompt: "x" })).rejects.toThrow("Connectez Claude Code ou Codex");
  });

  it("kev with a raised signal aborts the request to Kev", async () => {
    const kev = keep(await fakeSilentServer());
    const ai = new LocalAi({ folder: await tempFolder(), kevUrl: kev.url });
    toStop.push(ai);
    const controller = new AbortController();
    controller.abort();
    await expect(ai.kev({ state: "", questions: {} }, { signal: controller.signal })).rejects.toThrow(AI_ABANDONED);
    expect(kev.requests).toHaveLength(0);
  });

  it("model absent: « IA locale non installée », nothing launched", async () => {
    const launch = vi.fn();
    const ai = new LocalAi({ folder: await tempFolder(), llamaServer: LLAMA, launch, ...fast });
    await expect(ai.kev({ state: "", questions: {} })).rejects.toThrow("Local AI not installed");
    expect(ai.state().state).toBe("not-installed");
    expect(launch).not.toHaveBeenCalled();
  });

  it("no llama-server binary: « llama-server introuvable », state error", async () => {
    const launch = vi.fn();
    const ai = new LocalAi({ folder: await installed(), launch, locale: () => "fr", ...fast });
    await expect(ai.kev({ state: "", questions: {} })).rejects.toThrow("llama-server introuvable");
    expect(ai.state().state).toBe("error");
    expect(launch).not.toHaveBeenCalled();
  });

  it("launches llama-server with the model on 127.0.0.1", async () => {
    const folder = await installed();
    const kev = keep(await fakeKev());
    const port = Number(new URL(kev.url).port);
    const launches: { cmd: string; args: string[]; cwd: string }[] = [];
    const states: string[] = [];
    const launch = (cmd: string, args: string[], o: { cwd: string }): AiProcess => (launches.push({ cmd, args, cwd: o.cwd }), { stop() {}, onOutput() {} });
    const ai = new LocalAi({ folder, llamaServer: LLAMA, launch, port, onState: (e) => states.push(e), ...fast });
    toStop.push(ai);
    await ai.kev({ state: "", questions: {} });
    expect(kev.requests.filter((r) => r.url === "/v1/systemone")).toHaveLength(1);
    expect(launches).toEqual([{
      cmd: LLAMA,
      args: ["-m", join(folder, "d1", D1_FILE), "--host", "127.0.0.1", "--port", String(port), "-ngl", "99", "-np", "4", "-c", "16384", "-ub", "4096", "-b", "4096"],
      cwd: join(folder, "d1"),
    }]);
    expect(states).toEqual(["starting", "active"]);
    expect(ai.state().state).toBe("active");
  });

  it("warmDecision starts the server once and never throws", async () => {
    const launch = vi.fn((): AiProcess => ({ stop() {}, onOutput() {} }));
    const none = new LocalAi({ folder: await tempFolder(), llamaServer: LLAMA, launch, ...fast });
    expect(() => none.warmDecision()).not.toThrow();
    const noBinary = new LocalAi({ folder: await installed(), launch, ...fast });
    expect(() => noBinary.warmDecision()).not.toThrow(); // the rejection is swallowed
    expect(launch).not.toHaveBeenCalled();
    const ai = new LocalAi({ folder: await installed(), llamaServer: LLAMA, launch, port: 1, ...fast });
    toStop.push(ai);
    ai.warmDecision();
    ai.warmDecision();
    expect(launch).toHaveBeenCalledTimes(1);
    expect(ai.state().state).toBe("starting");
  });

  it("after 10 min without a call, the server is stopped (fake clock)", async () => {
    const kev = keep(await fakeKev());
    let now = 1000;
    let stopped = 0;
    const launch = (): AiProcess => ({ stop() { stopped++; }, onOutput() {} });
    const ai = new LocalAi({ folder: await installed(), llamaServer: LLAMA, launch, port: Number(new URL(kev.url).port), clock: () => now, inactivityMs: 600_000, ...fast });
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

  it("stop() at rest allows a relaunch; close() then refuses kev() and gemma() without launching anything", async () => {
    const kev = keep(await fakeKev());
    const writer = vi.fn();
    let launched = 0;
    const launch = (): AiProcess => (launched++, { stop() {}, onOutput() {} });
    const ai = new LocalAi({ folder: await installed(), llamaServer: LLAMA, launch, port: Number(new URL(kev.url).port), writer, ...fast });
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
    expect(writer).not.toHaveBeenCalled();
  });

  it("a kernel's access: once closed, it refuses and stops the server; another access relaunches it", async () => {
    const kev = keep(await fakeKev());
    let launched = 0;
    let stoppedList = 0;
    const launch = (): AiProcess => (launched++, { stop() { stoppedList++; }, onOutput() {} });
    const ai = new LocalAi({ folder: await installed(), llamaServer: LLAMA, launch, port: Number(new URL(kev.url).port), ...fast });
    toStop.push(ai);
    const first = ai.access();
    await first.kev({ state: "", questions: {} });
    await first.close();
    expect(stoppedList).toBe(1);
    expect(ai.state().state).toBe("stopped");
    await expect(first.kev({ state: "", questions: {} })).rejects.toThrow("IA locale fermée");
    await expect(first.gemma({ prompt: "x" })).rejects.toThrow("IA locale fermée");
    expect(launched).toBe(1);
    await ai.access().kev({ state: "", questions: {} });
    expect(launched).toBe(2);
  });

  it("stopServers when nothing started (AI off at launch) launches and changes nothing", async () => {
    const launch = vi.fn((): AiProcess => ({ stop() {}, onOutput() {} }));
    const ai = new LocalAi({ folder: await installed(), llamaServer: LLAMA, launch, ...fast });
    toStop.push(ai);
    await ai.stopServers();
    expect(launch).not.toHaveBeenCalled();
    expect(ai.state().state).toBe("stopped");
    expect(ai.embed.state().state).toBe("stopped");
  });

  it("stopServers (AI off) stops the decision server and the search model's", async () => {
    const kev = keep(await fakeKev());
    let stopped = 0;
    const launch = (): AiProcess => ({ stop() { stopped++; }, onOutput() {} });
    const ai = new LocalAi({ folder: await installed(), llamaServer: LLAMA, launch, port: Number(new URL(kev.url).port), ...fast });
    toStop.push(ai);
    const embedStop = vi.spyOn(ai.embed, "stop");
    await ai.kev({ state: "", questions: {} });
    await ai.stopServers();
    expect(stopped).toBe(1);
    expect(embedStop).toHaveBeenCalledOnce();
    expect(ai.state().state).toBe("stopped");
  });
});

describe("LocalAi: the models' downloads", () => {
  const data = Buffer.from("d1 weights ".repeat(5000));
  const final = (folder: string) => join(folder, "d1", D1_FILE);

  it("downloads, verifies and installs the model", async () => {
    const host = await fakeFile(data);
    const folder = await tempFolder();
    const seen: (number | null)[] = [];
    await new LocalAi({ folder, decisionUrl: host.url, decisionSha256: sha(data) }).installDecisionModel((p) => seen.push(p));
    expect(await readFile(final(folder))).toEqual(data);
    expect(existsSync(`${final(folder)}.part`)).toBe(false);
    expect(seen.at(-1)).toBe(100);
    expect(host.headers[0]!.range).toBeUndefined();
  });

  it("rejects a download longer than expected and leaves no .part", async () => {
    const host = await fakeFile(data);
    const folder = await tempFolder();
    const ai = new LocalAi({ folder, decisionUrl: host.url, decisionSha256: sha(data), decisionBytes: data.length - 1, locale: () => "en" });
    await expect(ai.installDecisionModel(() => {})).rejects.toThrow();
    expect(existsSync(`${final(folder)}.part`)).toBe(false);
    expect(existsSync(final(folder))).toBe(false);
  });

  it("cancelInstall stops the decision download and keeps the .part; a second install meanwhile is refused", async () => {
    const host = await fakeFile(data, { hold: true });
    const folder = await tempFolder();
    const ai = new LocalAi({ folder, decisionUrl: host.url, decisionSha256: sha(data), locale: () => "fr" });
    let started!: () => void;
    const running = new Promise<void>((ok) => (started = ok));
    const install = ai.installDecisionModel((p) => p && started());
    await running;
    await expect(ai.installDecisionModel(() => {})).rejects.toThrow("Installation déjà en cours");
    ai.cancelInstall();
    await expect(install).rejects.toThrow("Installation annulée");
    expect(existsSync(`${final(folder)}.part`)).toBe(true);
    expect(existsSync(final(folder))).toBe(false);
  });

  it("the search model downloads into embed/ from embedUrl, beside d1", async () => {
    const host = await fakeFile(data);
    const folder = await tempFolder();
    const ai = new LocalAi({ folder, embedUrl: host.url, embedSha256: sha(data) });
    await ai.embed.install(() => {});
    expect(await readFile(join(folder, "embed", EMBED_MODEL.file))).toEqual(data);
    expect(await ai.check().then((v) => [v.decision, v.embed], () => null)).toEqual([false, true]);
  });

  it("cancelInstall cancels both downloads; close() cancels and refuses new ones", async () => {
    const host = await fakeFile(data, { hold: true });
    const fresh = async () => new LocalAi({ folder: await tempFolder(), decisionUrl: host.url, decisionSha256: sha(data), embedUrl: host.url, embedSha256: sha(data), locale: () => "fr" });
    let ai = await fresh();
    const start = async () => {
      let started = 0;
      let ok!: () => void;
      const running = new Promise<void>((r) => (ok = r));
      const tick = (p: number | null) => void (p && ++started === 2 && ok());
      const installs = [ai.installDecisionModel(tick), ai.embed.install(tick)];
      await running;
      return installs;
    };
    const first = await start();
    ai.cancelInstall();
    for (const i of first) await expect(i).rejects.toThrow("Installation annulée");
    ai = await fresh(); // a new folder: the first one's .part files already hold the held half
    const second = await start();
    await ai.close();
    for (const i of second) await expect(i).rejects.toThrow("Installation annulée");
    await expect(ai.installDecisionModel(() => {})).rejects.toThrow("IA locale fermée");
    await expect(ai.embed.install(() => {})).rejects.toThrow("IA locale fermée");
  });

});
