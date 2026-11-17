import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { downloadVerified } from "../src/download.js";

const body = Buffer.from("0123456789".repeat(100));
const sha = createHash("sha256").update(body).digest("hex");

let dir: string;
let server: Server;
let url: string;
let ranges: Array<string | undefined>;
let mode: "normal" | "416";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "download-"));
  ranges = [];
  mode = "normal";
  server = createServer((req, res) => {
    ranges.push(req.headers.range);
    if (mode === "416") return void res.writeHead(416).end();
    const m = /bytes=(\d+)-/.exec(req.headers.range ?? "");
    const start = m ? Number(m[1]) : 0;
    res.writeHead(m ? 206 : 200, { "content-length": body.length - start }).end(body.subarray(start));
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}/f`;
});
afterEach(async () => {
  server.close();
  await rm(dir, { recursive: true, force: true });
});

const run = (o: { sha256?: string; bytes?: number } = {}) =>
  downloadVerified({
    url, file: join(dir, "f.bin"), sha256: o.sha256 ?? sha, bytes: o.bytes ?? body.length,
    signal: new AbortController().signal, onPercent: () => {}, cancelled: () => new Error("cancelled"),
  });

describe("downloadVerified", () => {
  it("resumes from the .part with a range request", async () => {
    await writeFile(join(dir, "f.bin.part"), body.subarray(0, 300));
    await run();
    expect(ranges).toEqual(["bytes=300-"]);
    expect(await readFile(join(dir, "f.bin"))).toEqual(body);
    expect(existsSync(join(dir, "f.bin.part"))).toBe(false);
  });

  it("a wrong hash deletes the part and throws", async () => {
    await expect(run({ sha256: "0".repeat(64) })).rejects.toThrow("hash mismatch");
    expect(existsSync(join(dir, "f.bin.part"))).toBe(false);
    expect(existsSync(join(dir, "f.bin"))).toBe(false);
  });

  it("a body longer than bytes is aborted", async () => {
    await expect(run({ bytes: 500 })).rejects.toThrow("too many bytes");
    expect(existsSync(join(dir, "f.bin.part"))).toBe(false);
  });

  it("416 keeps the part and verifies it", async () => {
    await writeFile(join(dir, "f.bin.part"), body);
    mode = "416";
    await run();
    expect(await readFile(join(dir, "f.bin"))).toEqual(body);
  });
});
