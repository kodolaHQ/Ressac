import { expect, test, vi } from "vitest";
import dns from "node:dns";
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { checkUrl, fetch, localUrl, onOwnNetwork } from "../../src/workflows/access.js";

test.each([
  "198.18.0.1", "198.19.249.3", // benchmarking range, OrbStack's machines
  "[fec0::1]", "[ff02::1]", "[ff05::2]", // site-local, multicast
  "[2002:7f00:1::]", "[2002:c0a8:101::1]", // 6to4: a v4 address inside
  "[2001:0:4136:e378:8000:63bf:3fff:fdd2]", // Teredo
  "10.1.2.3", "172.16.0.1", "169.254.1.1", "100.64.0.1", "0.0.0.0", "224.0.0.1", "[fd12::1]", "[fe80::1]",
])("local by its text: %s", (host) => expect(localUrl(host)).toBe(true));

test.each(["198.20.0.1", "8.8.8.8", "[2a00:1450:4007:80e::200e]", "[2001:db8::1]", "example.com"])("not local by its text: %s", (host) =>
  expect(localUrl(host)).toBe(false),
);

const interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = {
  lo0: [{ address: "::1", family: "IPv6", internal: true, netmask: "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", cidr: "::1/128", mac: "00:00:00:00:00:00", scopeid: 0 }],
  en0: [
    { address: "2a01:cb00:1234:5600:1c2d:3e4f:5a6b:7c8d", family: "IPv6", internal: false, netmask: "ffff:ffff:ffff:ffff::", cidr: null, mac: "aa:bb:cc:dd:ee:ff", scopeid: 0 },
    { address: "86.247.10.20", family: "IPv4", internal: false, netmask: "255.255.255.0", cidr: null, mac: "aa:bb:cc:dd:ee:ff" },
  ],
};

test("the machine's own addresses, and IPv6 neighbours on its /64, are its network", () => {
  expect(onOwnNetwork("2a01:cb00:1234:5600:1c2d:3e4f:5a6b:7c8d", interfaces)).toBe(true);
  expect(onOwnNetwork("[2a01:cb00:1234:5600::42]", interfaces)).toBe(true);
  expect(onOwnNetwork("86.247.10.20", interfaces)).toBe(true);
  expect(onOwnNetwork("2a01:cb00:1234:5601::1", interfaces)).toBe(false);
  expect(onOwnNetwork("86.247.10.21", interfaces)).toBe(false);
  expect(onOwnNetwork("example.com", interfaces)).toBe(false);
});

test("checkUrl refuses an address of this machine given as a literal", () => {
  const [own] = Object.values(networkInterfaces()).flat().filter((i) => i && !i.internal && i.family === "IPv4");
  if (!own) return;
  expect(() => checkUrl(`http://${own!.address}/`, null, false)).toThrow("Adresse locale refusée");
  expect(() => checkUrl(`http://${own!.address}/`, null, true)).not.toThrow();
});

test("a read of a server on this machine's own non-loopback address is refused (the bench's IPv6 case, any family)", async () => {
  const own = Object.values(networkInterfaces()).flat().filter((i) => i && !i.internal && !i.address.startsWith("fe80"));
  for (const i of own) {
    const server = createServer((_, res) => res.end("ANSWER"));
    await new Promise<void>((ok) => server.listen(0, i!.address, ok));
    const host = i!.family === "IPv6" ? `[${i!.address}]` : i!.address;
    try {
      await expect(fetch(`http://${host}:${(server.address() as AddressInfo).port}/`, "text", null, false)).rejects.toThrow("Adresse locale refusée");
    } finally {
      server.close();
    }
  }
});

test("a name that resolves to this machine's own global IPv6 address is refused at connection", async () => {
  // A global IPv6 address: a private v4 one is already refused by its text.
  const own = Object.values(networkInterfaces()).flat().find((i) => i && !i.internal && i.family === "IPv6" && !localUrl(i.address));
  if (!own) return;
  const server = createServer((_, res) => res.end("ANSWER"));
  await new Promise<void>((ok) => server.listen(0, own.address, ok));
  const resolution = vi.spyOn(dns, "lookup").mockImplementation(((_h: string, _o: unknown, callback: (e: null, a: dns.LookupAddress[]) => void) =>
    callback(null, [{ address: own.address, family: 6 }])) as unknown as typeof dns.lookup);
  try {
    await expect(fetch(`http://piege.example:${(server.address() as AddressInfo).port}/`, "text", null, false)).rejects.toThrow("Adresse locale refusée");
  } finally {
    resolution.mockRestore();
    server.close();
  }
});
