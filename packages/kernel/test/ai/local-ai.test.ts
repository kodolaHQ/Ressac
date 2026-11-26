import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { LocalAi } from "../../src/ai/local-ai.js";
import { EMBED_MODEL, type AiProcess } from "../../src/ai/llama-model.js";
import { tempFolder } from "../helpers/temp.js";
import { fakeOllama, type FakeServer } from "../helpers/fake-ai.js";

const toClose: FakeServer[] = [];
afterEach(async () => {
  for (const s of toClose.splice(0)) await s.close();
});
const keep = <T extends FakeServer>(s: T) => (toClose.push(s), s);
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** Fake model host serving `data`. */
async function fakeFile(data: Buffer) {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-length": data.length });
    res.end(data);
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  return keep({
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/model`,
    requests: [],
    close: () => new Promise<void>((ok) => { server.closeAllConnections(); server.close(() => ok()); }),
  });
}

describe("LocalAi", () => {
  it("check reports only the search model", async () => {
    const folder = await tempFolder();
    const ai = new LocalAi({ folder });
    expect(await ai.check()).toEqual({ embed: false });
    await mkdir(join(folder, "embed"), { recursive: true });
    await writeFile(join(folder, "embed", EMBED_MODEL.file), "gguf");
    expect(await ai.check()).toEqual({ embed: true });
    expect(ai.embed.installed()).toBe(true);
  });

  it("a folder left by an older Ressac (d1, Kev, its own Ollama) loads: check works and no call reaches Ollama", async () => {
    const ollama = keep(await fakeOllama('{"a":1}', ["gemma4:e4b-mlx"]));
    const folder = await tempFolder();
    await mkdir(join(folder, "d1"), { recursive: true });
    await mkdir(join(folder, "kev"), { recursive: true });
    const before = process.env.RESSAC_OLLAMA_URL;
    process.env.RESSAC_OLLAMA_URL = ollama.url;
    try {
      const ai = new LocalAi({ folder });
      expect(await ai.check()).toEqual({ embed: false });
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
    expect(Object.keys(access).sort()).toEqual(["close", "gemma"]);
    expect(await access.gemma({ prompt: "p", json: true })).toEqual({ a: 1 });
    expect(writer).toHaveBeenCalledWith({ prompt: "p", json: true, images: undefined, signal: undefined });
    await access.close();
    await expect(access.gemma({ prompt: "p" })).rejects.toThrow("IA locale fermée");
    expect(writer).toHaveBeenCalledTimes(1);
  });

  it("closing an access leaves the search model's server alone; another access still writes", async () => {
    const writer = vi.fn().mockResolvedValue("ok");
    const ai = new LocalAi({ folder: await tempFolder(), writer });
    const embedStop = vi.spyOn(ai.embed, "stop");
    await ai.access().close();
    expect(embedStop).not.toHaveBeenCalled();
    expect(await ai.access().gemma({ prompt: "p" })).toBe("ok");
  });

  it("without a writer, gemma() rejects with the writer's no-account error", async () => {
    const ai = new LocalAi({ folder: await tempFolder(), locale: () => "fr" });
    await expect(ai.gemma({ prompt: "x" })).rejects.toThrow("Connectez Claude Code ou Codex");
    await expect(ai.access().gemma({ prompt: "x" })).rejects.toThrow("Connectez Claude Code ou Codex");
  });

  it("close() refuses gemma() without launching anything", async () => {
    const writer = vi.fn();
    const launch = vi.fn((): AiProcess => ({ stop() {}, onOutput() {} }));
    const ai = new LocalAi({ folder: await tempFolder(), launch, writer });
    await ai.close();
    await expect(ai.gemma({ prompt: "x" })).rejects.toThrow("IA locale fermée");
    expect(launch).not.toHaveBeenCalled();
    expect(writer).not.toHaveBeenCalled();
  });

  it("stopServers when nothing started (AI off at launch) launches and changes nothing", async () => {
    const launch = vi.fn((): AiProcess => ({ stop() {}, onOutput() {} }));
    const ai = new LocalAi({ folder: await tempFolder(), llamaServer: "/opt/llama/llama-server", launch });
    await ai.stopServers();
    expect(launch).not.toHaveBeenCalled();
    expect(ai.embed.state().state).toBe("stopped");
  });
});

describe("LocalAi: the search model's download", () => {
  const data = Buffer.from("weights ".repeat(5000));

  it("downloads into embed/ from embedUrl", async () => {
    const host = await fakeFile(data);
    const folder = await tempFolder();
    const ai = new LocalAi({ folder, embedUrl: host.url, embedSha256: sha(data) });
    await ai.embed.install(() => {});
    expect(await readFile(join(folder, "embed", EMBED_MODEL.file))).toEqual(data);
    expect(await ai.check()).toEqual({ embed: true });
  });

  it("cancelInstall reaches the download; close() refuses new ones (LlamaModel's own tests cover the cancel itself)", async () => {
    const ai = new LocalAi({ folder: await tempFolder() });
    const cancel = vi.spyOn(ai.embed, "cancelInstall");
    ai.cancelInstall();
    expect(cancel).toHaveBeenCalledOnce();
    await ai.close();
    await expect(ai.embed.install(() => {})).rejects.toThrow("IA locale fermée");
  });
});
