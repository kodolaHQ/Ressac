import { expect, test } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  grantCovers, grantNeeded, storeSiteGrant, rightsOf, siteExtensionsHash, siteReadHash, readSiteGrants, removeSiteGrant,
  siteStartKey, readSiteStarts, changeSiteStarts,
} from "../../src/sites/grants.js";
import type { DeclarationSite } from "../../src/sites/schemas.js";
import { tempFolder } from "../helpers/temp.js";

const base: DeclarationSite = {
  name: "Vidola", description: "", url: "https://vidola-a.example/", domains: ["vidola-a.example"],
  login: [], tweaks: [{ matches: ["/series/*"], js: ["a.js"], css: [], frames: ["https://*.clipsy.*/*"] }], resume: false,
};

test("without tweak or reprise: no grant needed", () => {
  expect(grantNeeded({ ...base, tweaks: [] })).toBe(false);
  expect(grantNeeded(base)).toBe(true);
  expect(grantNeeded({ ...base, tweaks: [], resume: true })).toBe(true);
});

test("droitsDe: union of the frame patterns", () => {
  const d = { ...base, tweaks: [...base.tweaks, { matches: ["/a"], js: [], css: ["b.css"], frames: ["https://x.example/*"] }, { matches: ["/b"], js: [], css: ["c.css"], frames: false as const }] };
  expect(rightsOf(d).frames).toEqual(["https://*.clipsy.*/*", "https://x.example/*"]);
});

test("granted then tweaks code changed: still covers", () => {
  const a = rightsOf(base);
  expect(grantCovers(a, { ...base, tweaks: [{ ...base.tweaks[0]!, js: ["autre.js", "encore.js"] }] })).toBe(true);
  expect(grantCovers(null, base)).toBe(false);
});

test("a domain address tracking moved the app to is not covered until granted", () => {
  const tracked = [...base.domains, "netflix-login.evil.example"];
  expect(grantCovers(rightsOf(base), base, tracked)).toBe(false);
  expect(grantCovers(rightsOf(base, tracked), base, tracked)).toBe(true);
});

test("domain, login domain, frame pattern added, or reprise set to true: no longer covers", () => {
  const a = rightsOf(base);
  expect(grantCovers(a, { ...base, domains: ["vidola-a.example", "autre.example"] })).toBe(false);
  expect(grantCovers(a, { ...base, login: ["login.example"] })).toBe(false);
  expect(grantCovers(a, { ...base, tweaks: [{ ...base.tweaks[0]!, frames: ["https://*.clipsy.*/*", "https://pub.example/*"] }] })).toBe(false);
  expect(grantCovers(a, { ...base, resume: true })).toBe(false);
  expect(grantCovers(a, base)).toBe(true);
});

test("correspond changed: still covers", () => {
  const a = rightsOf(base);
  expect(grantCovers(a, { ...base, tweaks: [{ ...base.tweaks[0]!, matches: ["/films/*"] }] })).toBe(true);
});

test("removeSiteGrant then readSiteGrants: absent; file in the profile, simultaneous grants kept", async () => {
  const p = await tempFolder();
  await Promise.all([storeSiteGrant(p, "a", base), storeSiteGrant(p, "b", base)]);
  expect(Object.keys(await readSiteGrants(p)).sort()).toEqual(["a", "b"]);
  expect(JSON.parse(await readFile(join(p, "site-grants.json"), "utf8")).a.domains).toEqual(["vidola-a.example"]);
  await removeSiteGrant(p, "a");
  expect(Object.keys(await readSiteGrants(p))).toEqual(["b"]);
  await expect(storeSiteGrant(p, "../x", base)).rejects.toThrow();
});

test("ids constructor, toString, __proto__: no grant, nothing throws", async () => {
  const p = await tempFolder();
  const a = await readSiteGrants(p);
  for (const id of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
    expect(a[id]).toBeUndefined();
    expect(() => grantCovers(a[id] ?? null, base)).not.toThrow();
  }
  await storeSiteGrant(p, "constructor", base);
  await writeFile(join(p, "site-grants.json"), JSON.stringify({ constructor: rightsOf(base) }));
  expect((await readSiteGrants(p))["constructor"]).toEqual(rightsOf(base));
  expect((await readSiteGrants(p))["toString"]).toBeUndefined();
});

test("failing read (neither absent nor damaged): the write fails without erasing the other grants", async () => {
  const p = await tempFolder();
  await storeSiteGrant(p, "a", base);
  await rm(join(p, "site-grants.json"));
  await mkdir(join(p, "site-grants.json")); // read a folder: EISDIR
  await expect(storeSiteGrant(p, "b", base)).rejects.toThrow();
  await rm(join(p, "site-grants.json"), { recursive: true });
  await writeFile(join(p, "site-grants.json"), "{abîmé");
  await storeSiteGrant(p, "c", base); // damaged: starts from zero
  expect(Object.keys(await readSiteGrants(p))).toEqual(["c"]);
});

test("siteReadHash: name, domains and login; the order and case of the domains change nothing", () => {
  const updateEntry = { ...base, login: ["compte.example"] };
  const e = siteReadHash(updateEntry);
  expect(e).toMatch(/^[0-9a-f]{64}$/);
  expect(siteReadHash({ ...updateEntry, domains: ["Vidola-A.example", "vidola-a.example"] })).toBe(e);
  expect(siteReadHash({ ...updateEntry, domains: ["b.example", "vidola-a.example"] })).toBe(siteReadHash({ ...updateEntry, domains: ["vidola-a.example", "b.example"] }));
  // What the card does not show does not count.
  expect(siteReadHash({ ...updateEntry, description: "autre", tweaks: [], resume: true })).toBe(e);
  // One more domain, login or name: another hash.
  expect(siteReadHash({ ...updateEntry, domains: [...updateEntry.domains, "mail.example.com"] })).not.toBe(e);
  expect(siteReadHash({ ...updateEntry, login: [...updateEntry.login, "accounts.google.com"] })).not.toBe(e);
  expect(siteReadHash({ ...updateEntry, name: "Mail" })).not.toBe(e);
  // The fields are not confused (a domain moved to login changes the hash).
  expect(siteReadHash({ ...updateEntry, domains: [], login: ["vidola-a.example", "compte.example"] })).not.toBe(e);
});

test("siteExtensionsHash: stable for another name, other tweaks, another reprise, another order or another case; changes with one more domain", () => {
  const e = siteExtensionsHash(base);
  expect(e).toMatch(/^[0-9a-f]{64}$/);
  expect(siteExtensionsHash({ ...base, name: "Autre", tweaks: [], resume: true })).toBe(e);
  const two = { ...base, domains: ["a.example", "B.example"], login: ["c.example", "d.example"] };
  expect(siteExtensionsHash({ ...two, domains: ["b.EXAMPLE", "a.example", "a.example"], login: ["D.example", "c.example"] })).toBe(siteExtensionsHash(two));
  expect(siteExtensionsHash({ ...base, domains: [...base.domains, "autre.example"] })).not.toBe(e);
  expect(siteExtensionsHash({ ...base, login: ["login.example"] })).not.toBe(e);
  expect(siteExtensionsHash({ ...base, domains: [], login: ["vidola-a.example"] })).not.toBe(e);
});

test("start key: the start address, the reference page and the domains; the starts file: null until written, fresh only the first time", async () => {
  const composed = { ...base, url: "https://vidola-a.example/?mails=secret" };
  expect(siteStartKey(composed)).not.toBe(siteStartKey(base));
  expect(siteStartKey({ ...base, urlTracking: { page: "https://ref.example/?x=1", pattern: "vidola" } })).not.toBe(siteStartKey(base));
  expect(siteStartKey({ ...base, domains: [...base.domains, "evil.example"] })).not.toBe(siteStartKey(base));
  expect(siteStartKey({ ...base, domains: ["VIDOLA-A.example"] })).toBe(siteStartKey(base));
  expect(siteStartKey({ ...base, name: "Autre", tweaks: [] })).toBe(siteStartKey(base));
  const dir = await tempFolder();
  try {
    expect(await readSiteStarts(dir)).toBeNull();
    const fresh: boolean[] = [];
    await changeSiteStarts(dir, (s, f) => void (fresh.push(f), (s.vidola = siteStartKey(base))));
    await changeSiteStarts(dir, (_s, f) => void fresh.push(f));
    expect(fresh).toEqual([true, false]);
    expect({ ...(await readSiteStarts(dir)) }).toEqual({ vidola: siteStartKey(base) });
    await writeFile(join(dir, "site-starts.json"), "{oops");
    expect({ ...(await readSiteStarts(dir)) }).toEqual({});
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
