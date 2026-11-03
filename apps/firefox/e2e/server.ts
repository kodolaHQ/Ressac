import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

const PAGES = path.resolve(import.meta.dirname, "../../navigateur/e2e/pages");
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".txt": "text/plain" };

/** A 1×1 red PNG. */
const ICON = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64");

/**
 * Serves the Electron e2e pages read-only; /cookie sets a persistent cookie, /lire-cookie shows the cookies in its title,
 * /icone is a page with an http favicon (/icone.png) and a pure red background.
 */
export async function startServer(): Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer((req, res) => {
    const route = new URL(req.url ?? "/", "http://x").pathname;
    if (route === "/cookie") {
      res.writeHead(200, { "Set-Cookie": "essai=1; Max-Age=86400; Path=/", "Content-Type": "text/html" });
      return res.end("<title>cookie</title>ok");
    }
    if (route === "/lire-cookie") {
      res.writeHead(200, { "Content-Type": "text/html" });
      return res.end(`<title>${req.headers.cookie ?? "aucun"}</title>`);
    }
    if (route === "/icone") {
      res.writeHead(200, { "Content-Type": "text/html" });
      return res.end('<title>icone</title><link rel="icon" href="/icone.png"><body style="background: rgb(255, 0, 0)">');
    }
    if (route === "/icone.png") return res.writeHead(200, { "Content-Type": "image/png" }).end(ICON);
    const file = path.join(PAGES, path.normalize(route));
    if (!file.startsWith(PAGES + path.sep) || !existsSync(file)) return res.writeHead(404).end();
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream" });
    res.end(readFileSync(file));
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () =>
      new Promise((ok) => {
        server.close(() => ok());
        server.closeAllConnections(); // Firefox keeps connections alive
      }),
  };
}
