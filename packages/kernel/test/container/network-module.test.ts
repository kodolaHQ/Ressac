import { describe, expect, test } from "vitest";
import { once } from "node:events";
import { connect } from "node:net";
// @ts-expect-error plain .mjs that runs inside the image, no type declarations
import { validDomain, allowed, rules, BASE_DOMAINS, createProxy } from "../../docker/ressac-network.mjs";

describe("validDomain", () => {
  test.each(["example.com", "*.example.com", "a-b.example.co.uk"])("accepts %s", (d) => {
    expect(validDomain(d)).toBe(true);
  });
  test.each(["Example.com", "example", "*.com", "1.2.3.4", "example.com:443", "example.com/x", "-a.com", "a..com", "", `${"a".repeat(250)}.com`])(
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

test("proxy refuses a host outside the list with 403", async () => {
  const server = createProxy(() => ["example.com"]);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const socket = connect(port, "127.0.0.1");
  socket.write("CONNECT evil.com:443 HTTP/1.1\r\nHost: evil.com:443\r\n\r\n");
  const [data] = await once(socket, "data");
  expect(String(data)).toContain("403");
  socket.destroy();
  server.close();
});
