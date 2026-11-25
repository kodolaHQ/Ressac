// The passport of the real-browser replay (B3): the profile's own entries plus one per leaked item the decisions make a
// field (replay-cases.json `passport`; masking and out-of-promise items get none).
//   node passport.mjs --selftest
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { PROFILES } from "../profiles.mjs";

const ORIGINS = ["mail.novacourriel.fr", "www.banque-ardoise.fr"];
/** The profile value each canary id stands for (profiles.mjs `values`). */
const VALUE_KEY = { "client-id": "client", balance: "balance", contract: "contract", advisor: "advisor", "door-code": "door", doctor: "doctor", "lab-file": "lab" };
/** Stable, same in both profiles: `b3c` + 13 hex of the canary id (all hex, unlike the brief's « b3r »). */
const idOf = (canary) => "b3c" + createHash("sha256").update(canary).digest("hex").slice(0, 13);

export function replayPassport(profile, decisions) {
  const P = PROFILES[profile];
  const base = P.passport.perso.map((e) => ({ id: e.id, field: e.field, value: e.value, origins: [...new Set([...ORIGINS, ...e.origins])], variants: [] }));
  const have = new Set(base.map((e) => e.field));
  const extra = Object.entries(decisions)
    // The street is profile perso's `adresse` entry already (the kernel refuses a duplicate).
    .filter(([id, field]) => !["masking", "out-of-promise"].includes(field) && !(field === "adresse" && have.has("adresse")))
    .map(([id, field]) => {
      if (!VALUE_KEY[id]) throw new Error(`no value for canary ${id}`);
      return { id: idOf(id), field, value: { text: P.values[VALUE_KEY[id]] }, origins: [...ORIGINS], variants: [] };
    });
  return [...base, ...extra];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!process.argv.includes("--selftest")) throw new Error("usage: node passport.mjs --selftest");
  const assert = (await import("node:assert")).strict;
  const K = new URL("../../../../packages/kernel/", import.meta.url);
  const { tsImport } = await import(new URL("node_modules/tsx/dist/esm/api/index.mjs", K).href);
  const { validatePassport } = await tsImport(new URL("src/mask/passport-fields.ts", K).href, import.meta.url);
  const { passport } = JSON.parse(readFileSync(new URL("replay-cases.json", import.meta.url), "utf8"));
  const [a, b] = [replayPassport("a", passport), replayPassport("b", passport)];
  assert.ok(a.length > PROFILES.a.passport.perso.length);
  assert.deepEqual(a.map((e) => [e.id, e.field]), b.map((e) => [e.id, e.field]));
  const vals = (es) => es.map((e) => e.value.text ?? `${e.value.given} ${e.value.family}`);
  const bv = new Set(vals(b));
  assert.ok(vals(a).every((v) => !bv.has(v)), "no value in common");
  for (const [n, es] of [["a", a], ["b", b]]) {
    const stamped = es.map((e) => ({ how: "typed", created: "2026-11-23T10:00:00.000Z", updated: "2026-11-23T10:00:00.000Z", ...e }));
    assert.deepEqual(validatePassport(stamped).dropped, [], `${n}: the kernel keeps every entry`);
    for (const e of es) assert.match(e.id, /^[0-9a-f]{16}$/);
    assert.ok(es.every((e) => ORIGINS.every((o) => e.origins.includes(o))));
  }
  assert.equal(a.filter((e) => e.field === "adresse").length, 1);
  console.log("passport self-check ok");
}
