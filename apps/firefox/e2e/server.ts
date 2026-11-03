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
 * /icone is a page with an http favicon (/icone.png) and a pure red background, /avale a page that swallows every key.
 * Invisible reading: /sous-ressources?vers=<base> has a frame, an image and a fetch on <base>, /redirige?vers=<url>
 * answers 302, /dialogues calls print() and alert() while loading, /lent never answers, /balise sends a beacon to
 * <base>/balise on pagehide, /coop is sent with Cross-Origin-Opener-Policy: same-origin, /fenetres calls open(),
 * /telecharge is an attachment, /telecharge-cadre has it in a frame and clicks a download link to it, /travailleur installs /sw.js, which fetches <base>/sw 4 s later.
 * `host` "::1" listens on IPv6 loopback; `paths` lists every path asked, in order.
 */
export async function startServer(o: { host?: string } = {}): Promise<{ url: string; port: number; paths: string[]; close(): Promise<void> }> {
  const paths: string[] = [];
  const server = createServer((req, res) => {
    const asked = new URL(req.url ?? "/", "http://x");
    const route = asked.pathname;
    paths.push(route);
    const to = asked.searchParams.get("vers") ?? "";
    if (route === "/sous-ressources") {
      res.writeHead(200, { "Content-Type": "text/html" });
      return res.end(
        `<title>sous-ressources</title><p>Texte public</p><iframe src="${to}/cadre"></iframe><img src="${to}/image">` +
          `<script>fetch("${to}/fetch").catch(() => {})</script>`,
      );
    }
    if (route === "/redirige") return res.writeHead(302, { Location: to }).end();
    if (route === "/fenetres") {
      res.writeHead(200, { "Content-Type": "text/html" });
      return res.end('<title>fenetres</title><script>open("/a.html"); open("/b.html", "x", "width=300,height=300")</script><p>Ouvre</p>');
    }
    if (route === "/telecharge") return res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Disposition": 'attachment; filename="lu.bin"' }).end("x");
    if (route === "/telecharge-cadre") {
      res.writeHead(200, { "Content-Type": "text/html" });
      return res.end('<title>telecharge</title><iframe src="/telecharge"></iframe><a id="t" href="/telecharge" download>t</a><script>document.getElementById("t").click()</script>');
    }
    if (route === "/coop") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cross-Origin-Opener-Policy": "same-origin" });
      return res.end("<title>coop</title><p>Page isolée</p>");
    }
    if (route === "/balise") {
      res.writeHead(200, { "Content-Type": "text/html" });
      return res.end(`<title>balise</title><script>addEventListener("pagehide", () => navigator.sendBeacon("${to}/balise"))</script>`);
    }
    // A service worker that fetches <base>/sw 4 s after it installs, long after the read is over.
    if (route === "/travailleur") {
      res.writeHead(200, { "Content-Type": "text/html" });
      return res.end(`<title>travailleur</title><script>navigator.serviceWorker.register("/sw.js?vers=${encodeURIComponent(to)}")</script>`);
    }
    if (route === "/sw.js") {
      res.writeHead(200, { "Content-Type": "text/javascript" });
      return res.end(
        `addEventListener("install", (e) => e.waitUntil(new Promise((r) => setTimeout(r, 4000)).then(() => fetch(${JSON.stringify(`${to}/sw`)}).catch(() => {}))));`,
      );
    }
    if (route === "/dialogues") {
      res.writeHead(200, { "Content-Type": "text/html" });
      return res.end("<title>dialogues</title><script>print(); alert('a'); confirm('b'); prompt('c')</script><p>Après les dialogues</p>");
    }
    // Never answers: the read is aborted or times out. Its closed connection is noted as "/lent:fermée".
    if (route === "/lent") return void req.socket.once("close", () => paths.push("/lent:fermée"));
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
    if (route === "/avale") {
      res.writeHead(200, { "Content-Type": "text/html" });
      return res.end('<title>avale</title><script>addEventListener("keydown", (e) => e.preventDefault(), true)</script><input autofocus>');
    }
    if (route === "/icone.png") return res.writeHead(200, { "Content-Type": "image/png" }).end(ICON);
    const file = path.join(PAGES, path.normalize(route));
    if (!file.startsWith(PAGES + path.sep) || !existsSync(file)) return res.writeHead(404).end();
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream" });
    res.end(readFileSync(file));
  });
  const host = o.host ?? "127.0.0.1";
  await new Promise<void>((ok) => server.listen(0, host, ok));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://${host.includes(":") ? `[${host}]` : host}:${port}`,
    port,
    paths,
    close: () =>
      new Promise((ok) => {
        server.close(() => ok());
        server.closeAllConnections(); // Firefox keeps connections alive
      }),
  };
}
