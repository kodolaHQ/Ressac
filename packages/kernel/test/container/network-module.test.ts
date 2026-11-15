import { describe, expect, test } from "vitest";
import { once } from "node:events";
import { connect, createServer as createTcp } from "node:net";
import http from "node:http";
import { validDomain as kernelValidDomain } from "../../src/container/workshop.js";
// @ts-expect-error plain .mjs that runs inside the image, no type declarations
import { validDomain, allowed, rules, BASE_DOMAINS, createProxy } from "../../docker/ressac-network.mjs";

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
  });
});

test("rules", () => {
  const text = rules({ mac: "0.250.250.254", ports: [5300, 41000] });
  const lines = text.trim().split("\n");
  expect(lines[0]).toBe("*filter");
  expect(lines.at(-1)).toBe("COMMIT");
  expect(lines.at(-2)).toContain("REJECT");
  expect(text).toContain("-A OUTPUT -d 0.250.250.254/32 -p tcp --dport 5300 -j ACCEPT");
  expect(text).toContain("-A OUTPUT -d 0.250.250.254/32 -p tcp --dport 41000 -j ACCEPT");
  expect(text).toContain("-m owner --uid-owner ressac-proxy -j ACCEPT");
  expect(text).toContain("-m owner --uid-owner root -j ACCEPT");
  expect(text).toContain("-o lo -j ACCEPT");
  expect(text).toContain("ESTABLISHED,RELATED");
  expect(text).toContain(":OUTPUT ACCEPT");
});

async function startProxy(ports: number[], httpPort = 80) {
  const server = createProxy(() => ["localhost"], { ports, httpPort });
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
