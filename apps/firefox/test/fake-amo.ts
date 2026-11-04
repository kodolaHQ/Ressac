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
 * `refus`: the validation fails with that message; `delaiMs`: the version turns public that late; `erreurHttp`: the upload answers that code.
 */
export async function startFakeAmo(o: { refus?: string; delaiMs?: number; erreurHttp?: number } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "webaios-fake-amo-"));
  const envois: { guid: string; version: string; auth: string; methode: string }[] = [];
  const uploads = new Map<string, string>();
  const versions = new Map<string, { xpi: string; pret: number }>();
  const guids = new Set<string>();

  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const corps = Buffer.concat(chunks);
    const url = new URL(req.url!, "http://x");
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const rendre = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const auth = String(req.headers.authorization ?? "");
    let m: RegExpExecArray | null;
    if (req.method === "POST" && url.pathname === "/api/v5/addons/upload/") {
      if (o.erreurHttp) return rendre(o.erreurHttp, { detail: "fake error" });
      const fichier = ((await new Response(corps, { headers: { "content-type": String(req.headers["content-type"]) } }).formData()).get("upload") as File);
      const uuid = randomUUID();
      const xpi = path.join(dir, `${uuid}.xpi`);
      await writeFile(xpi, Buffer.from(await fichier.arrayBuffer()));
      uploads.set(uuid, xpi);
      return rendre(201, { uuid, processed: false, valid: false });
    }
    if (req.method === "GET" && (m = /^\/api\/v5\/addons\/upload\/([^/]+)\/$/.exec(url.pathname))) {
      if (!uploads.has(m[1]!)) return rendre(404, {});
      const messages = o.refus ? [{ type: "error", message: o.refus }] : [];
      return rendre(200, { uuid: m[1], processed: true, valid: !o.refus, validation: { messages } });
    }
    if ((m = /^\/api\/v5\/addons\/addon\/([^/]+)\/(versions\/(?:v(.+)\/)?)?$/.exec(url.pathname))) {
      const guid = decodeURIComponent(m[1]!);
      if (!m[2]) {
        if (req.method === "GET") return rendre(guids.has(guid) ? 200 : 404, {});
        if (req.method === "PUT" && !guids.has(guid)) return await creer(guid, "PUT", JSON.parse(corps.toString()).version.upload);
      } else if (m[3] === undefined) {
        if (req.method === "POST" && guids.has(guid)) return await creer(guid, "POST", JSON.parse(corps.toString()).upload);
      } else if (req.method === "GET") {
        const v = versions.get(`${guid}@${m[3]}`);
        if (!v) return rendre(404, {});
        return rendre(200, { file: { status: Date.now() >= v.pret ? "public" : "unreviewed", url: `${base}/download/${encodeURIComponent(guid)}/${m[3]}` } });
      }
    }
    if (req.method === "GET" && (m = /^\/download\/([^/]+)\/(.+)$/.exec(url.pathname))) {
      const v = versions.get(`${decodeURIComponent(m[1]!)}@${m[2]}`);
      if (!v) return rendre(404, {});
      res.writeHead(200, { "content-type": "application/x-xpinstall" });
      return res.end(await readFile(v.xpi));
    }
    rendre(404, {});

    async function creer(guid: string, methode: string, upload: string) {
      const xpi = uploads.get(upload);
      if (!xpi) return rendre(400, { upload: ["unknown upload"] });
      const manifeste = JSON.parse((await promisify(execFile)("unzip", ["-p", xpi, "manifest.json"])).stdout);
      if (versions.has(`${guid}@${manifeste.version}`)) return rendre(409, { version: [`Version ${manifeste.version} already exists.`] });
      guids.add(guid);
      versions.set(`${guid}@${manifeste.version}`, { xpi, pret: Date.now() + (o.delaiMs ?? 0) });
      envois.push({ guid, version: manifeste.version, auth, methode });
      rendre(methode === "PUT" ? 201 : 202, {});
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    envois,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await rm(dir, { recursive: true, force: true });
    },
  };
}
