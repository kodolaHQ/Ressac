import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { AI_CLOSED_ERROR, EMBED_MODEL, LlamaModel, launchAiProcess, type AiProcess, type LlamaModelOptions, type LlamaModelSpec } from "../../src/ai/llama-model.js";
import { tempFolder } from "../helpers/temp.js";
import { fakeForeign, fakeLlama, unreachableUrl, type FakeServer } from "../helpers/fake-ai.js";

const toClose: FakeServer[] = [];
const toStop: LlamaModel[] = [];
afterEach(async () => {
  for (const m of toStop.splice(0)) await m.stop();
  for (const s of toClose.splice(0)) await s.close();
});
const keep = <T extends FakeServer>(s: T) => (toClose.push(s), s);
const fast = { pollMs: 10, idleCheckMs: 10 };
const LLAMA = "/opt/llama/llama-server";
/** fakeLlama's /v1/models names the file: the spec under test uses it, on the fake's port when a test needs a ready server. */
const SPEC: LlamaModelSpec = { name: "m", file: "m.gguf", url: "http://127.0.0.1:9/m.gguf", sha256: "0", bytes: 1e9, port: 1, args: ["-ngl", "99", "--x"], idleMs: 600_000 };
const model = (o: Partial<LlamaModelOptions> & { folder: string }, spec: Partial<LlamaModelSpec> = {}) => {
  const m = new LlamaModel({ ...SPEC, ...spec }, { llamaServer: LLAMA, ...fast, ...o });
  toStop.push(m);
  return m;
};
const portOf = (s: FakeServer) => Number(new URL(s.url).port);
/** A folder where the model is already downloaded. */
async function installed(): Promise<string> {
  const folder = await tempFolder();
  await mkdir(join(folder, SPEC.name), { recursive: true });
  await writeFile(join(folder, SPEC.name, SPEC.file), "gguf");
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

describe("LlamaModel: the server", () => {
  it("the embedding model's spec: ggml-org's file at a pinned revision, no fixed port, mean-pooled embeddings, 2 min idle", () => {
    expect(EMBED_MODEL).toMatchObject({
      file: "embeddinggemma-300M-Q8_0.gguf",
      url: "https://huggingface.co/ggml-org/embeddinggemma-300M-GGUF/resolve/0f741b5a6585bd53aeb15cd1372c56f2a0f65e12/embeddinggemma-300M-Q8_0.gguf",
      bytes: 333590944,
      sha256: "b5ce9d77a3fc4b3b39ccb5643c36777911cc4eb46a66962eadfa3f5f60490d63",
      idleMs: 120_000,
    });
    expect(EMBED_MODEL.port).toBeUndefined(); // a free port per launch
    expect(EMBED_MODEL.args).toEqual(["--embedding", "--pooling", "mean", "-ngl", "99", "-ub", "2048", "-b", "2048"]);
  });

  it("model absent: « not installed », nothing launched", async () => {
    const launch = vi.fn();
    const m = model({ folder: await tempFolder(), launch });
    expect(m.installed()).toBe(false);
    await expect(m.ready()).rejects.toThrow("Local AI not installed");
    expect(m.state().state).toBe("not-installed");
    expect(launch).not.toHaveBeenCalled();
  });

  it("no llama-server binary: « llama-server introuvable », state error", async () => {
    const launch = vi.fn();
    const m = model({ folder: await installed(), launch, llamaServer: null, locale: () => "fr" });
    await expect(m.ready()).rejects.toThrow("llama-server introuvable");
    expect(m.state().state).toBe("error");
    expect(launch).not.toHaveBeenCalled();
  });

  it("launches llama-server with the model on 127.0.0.1, its port and its args, and answers its base URL once ready", async () => {
    const folder = await installed();
    const kev = keep(await fakeLlama());
    const launches: { cmd: string; args: string[]; cwd: string }[] = [];
    const states: string[] = [];
    const launch = (cmd: string, args: string[], o: { cwd: string }): AiProcess => (launches.push({ cmd, args, cwd: o.cwd }), { stop() {}, onOutput() {} });
    const m = model({ folder, launch, onState: (e) => states.push(e) }, { port: portOf(kev) });
    expect(m.installed()).toBe(true);
    expect(await m.ready()).toBe(kev.url);
    expect(launches).toEqual([{ cmd: LLAMA, args: ["-m", join(folder, "m", SPEC.file), "--host", "127.0.0.1", "--port", String(portOf(kev)), "-ngl", "99", "--x"], cwd: join(folder, "m") }]);
    expect(states).toEqual(["starting", "active"]);
    expect(await m.ready()).toBe(kev.url);
    expect(launches).toHaveLength(1);
  });

  it("serverUrl: ready() answers it without launching anything", async () => {
    const launch = vi.fn();
    const m = model({ folder: await tempFolder(), launch, serverUrl: "http://127.0.0.1:7" });
    expect(m.installed()).toBe(true);
    expect(await m.ready()).toBe("http://127.0.0.1:7");
    expect(m.state().state).toBe("active");
    expect(launch).not.toHaveBeenCalled();
  });

  it("a foreign server on the port (no model name) is not taken as ready", async () => {
    const foreign = keep(await fakeForeign());
    // Our process dies after a while: a ready server would have been accepted long before.
    const launch = (): AiProcess => ({ stop() {}, onOutput(r) { setTimeout(() => r(1), 100); } });
    const m = model({ folder: await installed(), launch }, { port: portOf(foreign) });
    await expect(m.ready()).rejects.toThrow("did not start");
    expect(m.state().state).toBe("error");
  });

  it("a server that dies at start is tried once more on the CPU, then rejects with its last lines; the next call tries the GPU again", async () => {
    const launched: string[][] = [];
    const launch = (_cmd: string, args: string[]): AiProcess => {
      launched.push(args);
      return { stop() {}, onLine(r) { r("loading model"); r("bind: address already in use"); }, onOutput(r) { setTimeout(() => r(1), 5); } };
    };
    const m = model({ folder: await installed(), launch }); // port 1: nothing answers there
    const start = Date.now();
    await expect(m.ready()).rejects.toThrow("bind: address already in use");
    expect(Date.now() - start).toBeLessThan(1000);
    expect(m.state().state).toBe("error");
    await expect(m.ready()).rejects.toThrow("bind: address already in use");
    expect(launched.map((a) => a.slice(-2))).toEqual([["99", "--x"], ["-ngl", "0"], ["99", "--x"], ["-ngl", "0"]]);
  });

  it("a GPU death at start: the CPU relaunch answers, and later launches stay on the CPU", async () => {
    const kev = keep(await fakeLlama());
    const launched: string[][] = [];
    const exits: ((c: number | null) => void)[] = [];
    const launch = (_cmd: string, args: string[]): AiProcess => {
      launched.push(args);
      // The GPU launch dies before the port answers... except fakeLlama answers at once: it dies on its first poll.
      return launched.length === 1 ? { stop() {}, onOutput(r) { r(134); } } : { stop() {}, onOutput(r) { exits.push(r); } };
    };
    const m = model({ folder: await installed(), launch }, { port: portOf(kev) });
    expect(await m.ready()).toBe(kev.url.replace(/\/$/, ""));
    expect(m.state().state).toBe("active");
    exits[0]!(139);
    await m.ready();
    expect(launched.map((a) => a.slice(-2))).toEqual([["99", "--x"], ["-ngl", "0"], ["-ngl", "0"]]);
  });

  it("relaunches after a crash; parallel calls start one server", async () => {
    const kev = keep(await fakeLlama());
    const exits: ((c: number | null) => void)[] = [];
    const launch = (): AiProcess => ({ stop() {}, onOutput(r) { exits.push(r); } });
    const m = model({ folder: await installed(), launch }, { port: portOf(kev) });
    await Promise.all([m.ready(), m.ready()]);
    expect(exits).toHaveLength(1);
    exits[0]!(139);
    expect(m.state().state).toBe("stopped");
    await m.ready();
    expect(exits).toHaveLength(2);
  });

  it("warm starts the server once and never throws", async () => {
    const launch = vi.fn((): AiProcess => ({ stop() {}, onOutput() {} }));
    const none = model({ folder: await tempFolder(), launch });
    expect(() => none.warm()).not.toThrow();
    const noBinary = model({ folder: await installed(), launch, llamaServer: null });
    expect(() => noBinary.warm()).not.toThrow(); // the rejection is swallowed
    expect(launch).not.toHaveBeenCalled();
    const m = model({ folder: await installed(), launch });
    m.warm();
    m.warm();
    expect(launch).toHaveBeenCalledTimes(1);
    expect(m.state().state).toBe("starting");
  });

  it("stop() during startup: state stopped, the waiting call abandoned (not a dead URL), no timer", async () => {
    let output!: (c: number | null) => void;
    const launch = (): AiProcess => ({ stop() { setTimeout(() => output(null), 1); }, onOutput(r) { output = r; } });
    const m = model({ folder: await installed(), launch });
    const call = m.ready().catch((e) => e);
    await new Promise((r) => setTimeout(r, 40));
    expect(m.state().state).toBe("starting");
    await m.stop();
    expect(await call).toMatchObject({ message: AI_CLOSED_ERROR });
    await new Promise((r) => setTimeout(r, 40));
    expect(m.state()).toEqual({ state: "stopped" });
    expect((m as any).timeout).toBeUndefined();
  });

  it("after idleMs without a call, the server is stopped (fake clock)", async () => {
    const kev = keep(await fakeLlama());
    let now = 1000;
    let stopped = 0;
    const launch = (): AiProcess => ({ stop() { stopped++; }, onOutput() {} });
    const m = model({ folder: await installed(), launch, clock: () => now }, { port: portOf(kev), idleMs: 600_000 });
    await m.ready();
    expect(m.state().state).toBe("active");
    now += 599_000;
    await new Promise((r) => setTimeout(r, 50));
    expect(m.state().state).toBe("active");
    now += 2_000;
    await new Promise((r) => setTimeout(r, 50));
    expect(m.state().state).toBe("stopped");
    expect(stopped).toBe(1);
  });

  it("the old server's late exit does not cancel the new server's idle stop", async () => {
    const kev = keep(await fakeLlama());
    let now = 1000;
    const exits: ((c: number | null) => void)[] = [];
    const launch = (): AiProcess => ({ stop() {}, onOutput(r) { exits.push(r); } });
    const m = model({ folder: await installed(), launch, clock: () => now }, { port: portOf(kev), idleMs: 600_000 });
    await m.ready();
    await m.stop();
    await m.ready();
    exits[0]!(null); // the first server only exits now
    expect(m.state().state).toBe("active");
    now += 601_000;
    await new Promise((r) => setTimeout(r, 50));
    expect(m.state().state).toBe("stopped");
  });

  it("no fixed port: each launch asks the OS for a free port, and ready() answers that process's URL", async () => {
    const servers: FakeServer[] = [];
    const ports: number[] = [];
    // A fake llama-server: listens on the port it was given and names the model.
    const launch = (_cmd: string, args: string[]): AiProcess => {
      const port = Number(args[args.indexOf("--port") + 1]);
      ports.push(port);
      const s = createServer((_q, res) => res.end(JSON.stringify({ data: [{ id: SPEC.file }] })));
      s.listen(port, "127.0.0.1");
      servers.push(keep({ url: "", requests: [], close: () => new Promise<void>((ok) => { s.closeAllConnections(); s.close(() => ok()); }) }));
      return { stop() {}, onOutput() {} };
    };
    const m = model({ folder: await installed(), launch }, { port: undefined });
    expect(await m.ready()).toBe(`http://127.0.0.1:${ports[0]}`);
    await m.stop();
    await servers[0]!.close();
    expect(await m.ready()).toBe(`http://127.0.0.1:${ports[1]}`);
    expect(ports).toHaveLength(2);
    for (const p of ports) expect(p).toBeGreaterThan(1024);
  });

  it("stop() allows a relaunch; close() then refuses ready(), warm() and install() without launching anything", async () => {
    const kev = keep(await fakeLlama());
    let launched = 0;
    const launch = (): AiProcess => (launched++, { stop() {}, onOutput() {} });
    const m = model({ folder: await installed(), launch }, { port: portOf(kev) });
    await m.ready();
    await m.stop();
    await m.ready();
    expect(launched).toBe(2);
    await m.close();
    expect(m.state().state).toBe("stopped");
    await expect(m.ready()).rejects.toThrow("IA locale fermée");
    m.warm();
    await expect(m.install(() => {})).rejects.toThrow("IA locale fermée");
    expect(launched).toBe(2);
  });
});

describe("LlamaModel: the download", () => {
  const data = Buffer.from("weights ".repeat(5000));
  const final = (folder: string) => join(folder, "m", SPEC.file);

  it("downloads, verifies and installs the model", async () => {
    const host = await fakeFile(data);
    const folder = await tempFolder();
    const seen: (number | null)[] = [];
    const m = model({ folder, urlOverride: host.url, sha256Override: sha(data) });
    await m.install((p) => seen.push(p));
    expect(await readFile(final(folder))).toEqual(data);
    expect(existsSync(`${final(folder)}.part`)).toBe(false);
    expect(m.installed()).toBe(true);
    expect(seen.at(-1)).toBe(100);
    expect(host.headers[0]!.range).toBeUndefined();
  });

  it("downloads from the spec's URL and checks the spec's hash without overrides", async () => {
    const host = await fakeFile(data);
    const folder = await tempFolder();
    await model({ folder }, { url: host.url, sha256: sha(data) }).install(() => {});
    expect(sha(await readFile(final(folder)))).toBe(sha(data));
  });

  it("rejects a download longer than expected and leaves no .part", async () => {
    const host = await fakeFile(data);
    const folder = await tempFolder();
    const m = model({ folder, urlOverride: host.url, sha256Override: sha(data) }, { bytes: data.length - 1 });
    await expect(m.install(() => {})).rejects.toThrow();
    expect(existsSync(`${final(folder)}.part`)).toBe(false);
    expect(existsSync(final(folder))).toBe(false);
  });

  it("resumes a partial download", async () => {
    const host = await fakeFile(data);
    const folder = await tempFolder();
    await mkdir(join(folder, "m"), { recursive: true });
    const half = data.length / 2;
    await writeFile(`${final(folder)}.part`, data.subarray(0, half));
    await model({ folder, urlOverride: host.url, sha256Override: sha(data) }).install(() => {});
    expect(host.headers[0]!.range).toBe(`bytes=${half}-`); // kept across the redirect
    expect(sha(await readFile(final(folder)))).toBe(sha(data));
  });

  it("rejects and deletes a file with the wrong hash", async () => {
    const host = await fakeFile(data);
    const folder = await tempFolder();
    const m = model({ folder, urlOverride: host.url, sha256Override: sha(Buffer.from("other")), locale: () => "fr" });
    await expect(m.install(() => {})).rejects.toThrow("Le modèle téléchargé est corrompu");
    expect(existsSync(final(folder))).toBe(false);
    expect(existsSync(`${final(folder)}.part`)).toBe(false);
  });

  it("an unreachable host rejects with the download error", async () => {
    const m = model({ folder: await tempFolder(), urlOverride: await unreachableUrl(), locale: () => "fr" });
    await expect(m.install(() => {})).rejects.toThrow("Le téléchargement du modèle a échoué");
  });

  it("cancelInstall stops the download and keeps the .part; a second install meanwhile is refused", async () => {
    const host = await fakeFile(data, { hold: true });
    const folder = await tempFolder();
    const m = model({ folder, urlOverride: host.url, sha256Override: sha(data), locale: () => "fr" });
    let started!: () => void;
    const running = new Promise<void>((ok) => (started = ok));
    const install = m.install((p) => p && started());
    await running;
    await expect(m.install(() => {})).rejects.toThrow("Installation déjà en cours");
    m.cancelInstall();
    await expect(install).rejects.toThrow("Installation annulée");
    expect(existsSync(`${final(folder)}.part`)).toBe(true);
    expect(existsSync(final(folder))).toBe(false);
  });

  it("close() cancels the download and refuses a new one", async () => {
    const host = await fakeFile(data, { hold: true });
    const m = model({ folder: await tempFolder(), urlOverride: host.url, sha256Override: sha(data), locale: () => "fr" });
    let started!: () => void;
    const running = new Promise<void>((ok) => (started = ok));
    const install = m.install((p) => p && started());
    await running;
    await m.close();
    await expect(install).rejects.toThrow("Installation annulée");
    await expect(m.install(() => {})).rejects.toThrow("IA locale fermée");
  });
});

describe("launchAiProcess (the server may launch a child process)", () => {
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

  it("stop() also kills the children (the whole group), not only the first process", async () => {
    const { p, pid, exited } = await launchWithChild("sleep 300 & echo $!; wait");
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
