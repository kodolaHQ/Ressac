import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

/**
 * A fake addons.mozilla.org following the v5 flow of plan 25's spike (upload, validation, PUT addon / POST versions,
 * version polling, download). The .xpi it hands back is the one received, unsigned.
 * `refus`: the validation fails with that message; `delaiMs`: the version turns public that late; `erreurHttp`: the upload answers that code; `erreurSondage`: the upload and version polls answer that code;
 * `statutFichier`: the version's file ends in that status ("disabled": AMO rejected it after validation).
 */
export async function startFakeAmo(o: { denial?: string; delayMs?: number; httpError?: number; pollError?: number; fileStatus?: string } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ressac-fake-amo-"));
  const sends: { guid: string; version: string; auth: string; method: string }[] = [];
  const uploads = new Map<string, string>();
  const versions = new Map<string, { xpi: string; ready: number }>();
  const guids = new Set<string>();

  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url!, "http://x");
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const render = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const auth = String(req.headers.authorization ?? "");
    let m: RegExpExecArray | null;
    if (req.method === "POST" && url.pathname === "/api/v5/addons/upload/") {
      if (o.httpError) return render(o.httpError, { detail: "fake error" });
      const file = ((await new Response(body, { headers: { "content-type": String(req.headers["content-type"]) } }).formData()).get("upload") as File);
      const uuid = randomUUID();
      const xpi = path.join(dir, `${uuid}.xpi`);
      await writeFile(xpi, Buffer.from(await file.arrayBuffer()));
      uploads.set(uuid, xpi);
      return render(201, { uuid, processed: false, valid: false });
    }
    if (req.method === "GET" && (m = /^\/api\/v5\/addons\/upload\/([^/]+)\/$/.exec(url.pathname))) {
      if (o.pollError) return render(o.pollError, {});
      if (!uploads.has(m[1]!)) return render(404, {});
      const messages = o.denial ? [{ type: "error", message: o.denial }] : [];
      return render(200, { uuid: m[1], processed: true, valid: !o.denial, validation: { messages } });
    }
    if ((m = /^\/api\/v5\/addons\/addon\/([^/]+)\/(versions\/(?:v(.+)\/)?)?$/.exec(url.pathname))) {
      const guid = decodeURIComponent(m[1]!);
      if (!m[2]) {
        if (req.method === "GET") return render(guids.has(guid) ? 200 : 404, {});
        if (req.method === "PUT" && !guids.has(guid)) return await create(guid, "PUT", JSON.parse(body.toString()).version.upload);
      } else if (m[3] === undefined) {
        if (req.method === "POST" && guids.has(guid)) return await create(guid, "POST", JSON.parse(body.toString()).upload);
      } else if (req.method === "GET") {
        if (o.pollError) return render(o.pollError, {});
        const v = versions.get(`${guid}@${m[3]}`);
        if (!v) return render(404, {});
        return render(200, { file: { status: o.fileStatus ?? (Date.now() >= v.ready ? "public" : "unreviewed"), url: `${base}/download/${encodeURIComponent(guid)}/${m[3]}` } });
      }
    }
    if (req.method === "GET" && (m = /^\/download\/([^/]+)\/(.+)$/.exec(url.pathname))) {
      const v = versions.get(`${decodeURIComponent(m[1]!)}@${m[2]}`);
      if (!v) return render(404, {});
      res.writeHead(200, { "content-type": "application/x-xpinstall" });
      return res.end(await readFile(v.xpi));
    }
    render(404, {});

    async function create(guid: string, method: string, upload: string) {
      const xpi = uploads.get(upload);
      if (!xpi) return render(400, { upload: ["unknown upload"] });
      const manifest = JSON.parse((await promisify(execFile)("unzip", ["-p", xpi, "manifest.json"])).stdout);
      if (versions.has(`${guid}@${manifest.version}`)) return render(409, { version: [`Version ${manifest.version} already exists.`] });
      guids.add(guid);
      versions.set(`${guid}@${manifest.version}`, { xpi, ready: Date.now() + (o.delayMs ?? 0) });
      sends.push({ guid, version: manifest.version, auth, method: method });
      render(method === "PUT" ? 201 : 202, {});
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    sends: sends,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await rm(dir, { recursive: true, force: true });
    },
  };
}
