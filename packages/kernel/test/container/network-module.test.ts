import { describe, expect, test, vi } from "vitest";
import { once } from "node:events";
import { connect, createServer as createTcp } from "node:net";
import http from "node:http";
import { validDomain as kernelValidDomain } from "../../src/container/workshop.js";
// @ts-expect-error plain .mjs that runs inside the image, no type declarations
import { validDomain, allowed, rules, BASE_DOMAINS, createProxy, localAddress } from "../../docker/ressac-network.mjs";

describe("validDomain", () => {
  test.each(["example.com", "*.example.com", "a-b.example.co.uk"])("accepts %s", (d) => {
    expect(validDomain(d)).toBe(true);
  });
  test.each(["Example.com", "example", "*.com", "1.2.3.4", "example.com:443", "example.com/x", "-a.com", "a..com", "", `${["a".repeat(63), "b".repeat(63), "c".repeat(63), "d".repeat(63)].join(".")}.com`])(
    "refuses %j",
    (d) => {
      expect(validDomain(d)).toBe(false);
    },
  );
});

describe("allowed", () => {
  test("base, wildcard, refusal, trailing dot", () => {
    expect(allowed("api.github.com", BASE_DOMAINS)).toBe(true);
    expect(allowed("x.example.com", ["*.example.com"])).toBe(true);
    expect(allowed("example.com", ["*.example.com"])).toBe(false);
    expect(allowed("evil.com", BASE_DOMAINS)).toBe(false);
    expect(allowed("github.com.", BASE_DOMAINS)).toBe(true);
    expect(allowed("evilexample.com", ["*.example.com"])).toBe(false);
    // An exact domain matches itself only, not a name ending with it.
    expect(allowed("evilgithub.com", ["github.com"])).toBe(false);
  });
});

test("rules", () => {
  const text = rules({ mac: "0.250.250.254", ports: [5300, 41000] });
  const lines = text.trim().split("\n");
  expect(lines[0]).toBe("*filter");
  expect(lines.at(-1)).toBe("COMMIT");
  // udp and tcp get a prompt refusal; the catch-all (ICMP, every other protocol) comes last.
  expect(lines.slice(-4, -1)).toEqual([
    "-A OUTPUT -p udp -j REJECT --reject-with icmp-port-unreachable",
    "-A OUTPUT -p tcp -j REJECT --reject-with tcp-reset",
    "-A OUTPUT -j REJECT",
  ]);
  expect(text).toContain("-A OUTPUT -d 0.250.250.254/32 -p tcp --dport 5300 -j ACCEPT");
  expect(text).toContain("-A OUTPUT -d 0.250.250.254/32 -p tcp --dport 41000 -j ACCEPT");
  expect(text).toContain("-m owner --uid-owner ressac-proxy -j ACCEPT");
  expect(text).toContain("-m owner --uid-owner root -j ACCEPT");
  expect(text).toContain("-o lo -j ACCEPT");
  expect(text).toContain("ESTABLISHED,RELATED");
  expect(text).toContain(":OUTPUT ACCEPT");
});

async function startProxy(ports: number[], httpPort = 80, localOk = true) {
  const server = createProxy(() => ["localhost"], { ports, httpPort, localOk });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { server, port: (server.address() as { port: number }).port };
}
const ask = async (port: number, head: string) => {
  const s = connect(port, "127.0.0.1");
  s.write(head);
  const [d] = await once(s, "data");
  return { s, text: String(d) };
};

describe("proxy", () => {
  test("allowed CONNECT pipes bytes both ways", async () => {
    const echo = createTcp((c) => c.pipe(c)).listen(0, "127.0.0.1");
    await once(echo, "listening");
    const up = (echo.address() as { port: number }).port;
    const { server, port } = await startProxy([up]);
    const { s, text } = await ask(port, `CONNECT localhost:${up} HTTP/1.1\r\nHost: x\r\n\r\n`);
    expect(text).toContain("200");
    s.write("ping");
    const [d] = await once(s, "data");
    expect(String(d)).toBe("ping");
    s.destroy();
    server.close();
    echo.close();
  });

  test("refused host and refused port get 403; a reset client does not kill the proxy", async () => {
    const { server, port } = await startProxy([443]);
    const { s, text } = await ask(port, "CONNECT evil.com:443 HTTP/1.1\r\nHost: x\r\n\r\n");
    expect(text).toContain("403");
    s.resetAndDestroy();
    expect((await ask(port, "CONNECT localhost:22 HTTP/1.1\r\nHost: x\r\n\r\n")).text).toContain("403");
    server.close();
  });

  test("plain-HTTP forward goes straight upstream (no proxy loop) with Host set from the URL", async () => {
    const up = http.createServer((q, r) => r.end(`body:${q.headers.host}`)).listen(0, "127.0.0.1");
    await once(up, "listening");
    const upPort = (up.address() as { port: number }).port;
    const { server, port } = await startProxy([443], upPort);
    vi.stubEnv("HTTP_PROXY", `http://127.0.0.1:${port}`);
    vi.stubEnv("NODE_USE_ENV_PROXY", "1");
    try {
      const body = await new Promise<string>((resolve, reject) => {
        http.get({ host: "127.0.0.1", port, path: `http://localhost:${upPort}/x`, headers: { host: "spoofed.example" }, agent: false }, (r) => {
          let t = "";
          r.on("data", (c) => (t += c)).on("end", () => resolve(t));
        }).on("error", reject);
      });
      expect(body).toBe(`body:localhost:${upPort}`);
    } finally {
      vi.unstubAllEnvs();
      server.close();
      up.close();
    }
  });

  test("an allowed name that resolves to a local address is refused, by CONNECT and by plain HTTP", async () => {
    const echo = createTcp((c) => c.pipe(c)).listen(0, "127.0.0.1");
    await once(echo, "listening");
    const up = (echo.address() as { port: number }).port;
    const { server, port } = await startProxy([up], up, false);
    const { s, text } = await ask(port, `CONNECT localhost:${up} HTTP/1.1\r\nHost: x\r\n\r\n`);
    expect(text).toContain("403");
    expect(text).toContain("local or private address");
    s.destroy();
    const status = await new Promise<number>((resolve) => {
      http.get({ host: "127.0.0.1", port, path: `http://localhost:${up}/`, headers: { host: "localhost" } }, (r) => (r.resume(), resolve(r.statusCode ?? 0)));
    });
    expect(status).toBe(403);
    server.close();
    echo.close();
  });

  test("localAddress: private, loopback, link-local and mapped ones; public ones pass", () => {
    for (const [a, f] of [["10.1.2.3", 4], ["127.0.0.1", 4], ["192.168.65.254", 4], ["172.20.0.1", 4], ["169.254.169.254", 4], ["100.64.0.1", 4], ["::1", 6], ["fd00::1", 6], ["fe80::1", 6], ["::ffff:10.0.0.1", 6]] as const) expect(localAddress(a, f), a).toBe(true);
    for (const [a, f] of [["93.184.216.34", 4], ["160.79.104.10", 4], ["2606:4700::1", 6]] as const) expect(localAddress(a, f), a).toBe(false);
  });

  test("plain HTTP to a host outside the list gets 403", async () => {
    const { server, port } = await startProxy([443], 80);
    const status = await new Promise<number>((resolve) => {
      http.get({ host: "127.0.0.1", port, path: "http://evil.example/", headers: { host: "evil.example" } }, (r) => (r.resume(), resolve(r.statusCode ?? 0)));
    });
    expect(status).toBe(403);
    server.close();
  });

  test("the shipped proxy (no options) refuses a name that resolves to a local address", async () => {
    const server = createProxy(() => ["localhost"]);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    const text = await new Promise<string>((resolve) => {
      http.get({ host: "127.0.0.1", port, path: "http://localhost/", headers: { host: "localhost" } }, (r) => {
        let t = "";
        r.on("data", (c) => (t += c)).on("end", () => resolve(`${r.statusCode} ${t}`));
      });
    });
    expect(text).toMatch(/^403 .*local or private address/);
    server.close();
  });

  test("plain-HTTP forward: non-80 port and relative URI get 403", async () => {
    const { server, port } = await startProxy([443], 80);
    for (const target of ["http://localhost:8080/", "/relative"]) {
      const status = await new Promise<number>((resolve) => {
        http.get({ host: "127.0.0.1", port, path: target, headers: { host: "localhost" } }, (r) => (r.resume(), resolve(r.statusCode ?? 0)));
      });
      expect(status).toBe(403);
    }
    server.close();
  });
});

// The settings validator (apps/firefox/shared/settings.ts) repeats these cases in test/state/actions.test.ts; this one holds the kernel and the image together.
describe("validDomain agreement (image, kernel)", () => {
  test.each(["example.com", "*.example.com", "a-b.example.co.uk", "Example.com", "example", "*.com", "1.2.3.4", "*.1.2", "example.com:443", "example.com/x", "-a.com", "a..com", "a b.com", ""])("%j", (d) => {
    expect(kernelValidDomain(d)).toBe(validDomain(d));
  });
});
