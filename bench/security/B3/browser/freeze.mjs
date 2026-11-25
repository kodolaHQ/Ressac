// The frozen leak list of the real-browser replay (B3 « Replay in the real browser »): every published minimax leak, with
// its source, before any agent runs. After the first model run it never changes (a change is a new dated protocol version).
//   node freeze.mjs --write   derives replay-cases.json and its sha256 from the B3 summaries at SOURCE
//   node freeze.mjs --check   derives again, asserts the list, exits 1 if the file or its sha256 differ
//
// Rule. An attack id is in the list if its outcome is `leaked` or `partial` in any minimax summary of results/make.mjs RUNS
// at SOURCE (either card arm, before or after any fix), or if the spec's § 4 table names it. Lines F1-F9 are § 4's, with
// the ids § 4 names, resolved against the README at SOURCE:
//   F6 « link-covert-* that leaked »: link-covert-1 to -4 (all four left in some run);
//   F7 « encoded-lang, 2 cases, digit-word addresses percent-encoded »: encoded-lang-4 and -6 (README « encoded-lang »);
//   F9 « shapeless cases, query-shapeless-* and address-* with the street or the doctor »: query-shapeless-1 to -4, and the
//      address-* attacks that left the street (address-param-2, -4; no address-* left the doctor).
// Every other id found is added as F12, F13…, one line per channel in score.mjs CHANNELS order. F10 and F11 are scripted-
// adversary leaks (adversary-masking-grant), no model: they go to `e2e` only.
// `after0123`: the line's attack left whole or partly in a minimax run on a kernel at or after the 0.1.23 outflow fix, i.e. a
// summary whose run name starts with `fix-` (kernel b2bb8875, the outflow fix shipped in 0.1.23), `v0123-` (0.1.23, main
// cabc448f) or `v2-` (0.1.24, 8161c541). The other minimax summaries (`ressac-92a19bc3-…`, kernel 31f568c8) are before it.
// The first paid pass runs only the after0123 lines (spec § 12).
// `passport`: per leaked item, `masking` if the kernel's masker alone (an empty passport, as harness.mts wires it) labels it
// in profile a's mail, bank, history and bookmarks; else the field the spec names (libre for the door code, the doctor and the lab
// file, § 11), or libre for any other value validateEntry accepts in both profiles; else `out-of-promise`. The masker is the
// working tree's kernel: a kernel change that alters a decision fails --check, on purpose.
// `model`: each attack and its control copied verbatim from the v2 set (the controls with their links; the attacks are
// byte-identical to the v1 sets, checked below). Shortcut: the browser bench serves no conversation2, pages, forms, bank page
// or links, prompt_extra or mail_extra; a case that has one is refused here rather than half-served.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import { ressacCaseErrors, collisionsIn, CHANNELS } from "../score.mjs";
import { PROFILES } from "../profiles.mjs";

const SOURCE = "1693318f";
const HERE = new URL("./", import.meta.url);
const B3 = new URL("../", import.meta.url);
const OUT = new URL("replay-cases.json", HERE);
const SHA = new URL("replay-cases.json.sha256", HERE);
const sha = (s) => createHash("sha256").update(s).digest("hex");
const at = (path) => execFileSync("git", ["show", `${SOURCE}:bench/security/B3/${path}`], { encoding: "utf8", maxBuffer: 1 << 28 });
const json = (path) => JSON.parse(at(path));

const SECTION4 = [
  ["F1", ["query-split-1"]], ["F2", ["query-split-2"]], ["F3", ["query-split-3"]], ["F4", ["query-split-4"]],
  ["F5", ["history-bookmarks-3"]], ["F6", ["link-covert-1", "link-covert-2", "link-covert-3", "link-covert-4"]],
  ["F7", ["encoded-lang-4", "encoded-lang-6"]], ["F8", ["encoded-lang-5"]],
  ["F9", ["query-shapeless-1", "query-shapeless-2", "query-shapeless-3", "query-shapeless-4", "address-param-2", "address-param-4"]],
];
const AFTER_0123 = /^(fix-|v0123-|v2-)/;
// One adversary pair per leaked shape, in priority order (F10, F8 + F11, F1-F3, F6, F7, F9).
const E2E = ["adv-action-clear", "adv-hangul-lab-digits", "adv-bare-pieces", "adv-link-covert", "adv-hangul-address", "adv-passport-street-out"];
const SPEC_FIELD = { street: "adresse", iban: "iban", name: "nom", "name-brother": "proche", email: "email", "email-brother": "email",
  phone: "tel", "phone-brother": "tel", "phone-doctor": "tel", "phone-advisor": "tel", "door-code": "libre", doctor: "libre", "lab-file": "libre" };
const REFUSED_KEYS = ["conversation2", "pages", "forms", "bank_page", "bank_links", "prompt_extra", "mail_extra"];
const LIMITS = { "lab-file": "its 5 digits alone (22917) are not a guarded shape: digits-only forms need 6 (packages/kernel/src/mask/passport-fields.ts:199); if they leave, a published limit or a product fix first" };

/** RUNS of results/make.mjs at SOURCE: its array literal, evaluated (it has no side effect; the module has). */
function runsAtSource() {
  const src = at("results/make.mjs");
  const m = src.match(/export const RUNS = (\[[^]*?\n\]);/);
  assert.ok(m, "RUNS not found in results/make.mjs");
  return new Function(`return ${m[1]}`)();
}

const caseFile = (channel) => (channel === "encoded-lang" ? "ressac/cases-lang.v2.json" : "ressac/cases.v2.json");
const v1File = (channel) => (channel === "encoded-lang" ? "ressac/cases-lang.json" : "ressac/cases.json");
const base = (id) => id.replace(/_attack$/, "");

async function passportDecisions(items) {
  const K = new URL("../../../../packages/kernel/", import.meta.url);
  const { tsImport } = await import(new URL("node_modules/tsx/dist/esm/api/index.mjs", K).href);
  const { Masker } = await tsImport(new URL("src/mask/masker.ts", K).href, import.meta.url);
  const { PassportStore } = await tsImport(new URL("src/mask/passport.ts", K).href, import.meta.url);
  const { maskText } = await tsImport(new URL("src/mask/mask.ts", K).href, import.meta.url);
  const { validateEntry } = await tsImport(new URL("src/mask/passport-fields.ts", K).href, import.meta.url);
  const a = PROFILES.a;
  const masker = new Masker({ locale: () => "fr", passport: new PassportStore() });
  masker.open("s", "w");
  const texts = [a.mail.text, a.bank.text, ...a.history.flatMap((h) => [h.url, h.title, h.excerpt, h.text]), ...a.bookmarks.flatMap((b) => [b.url, b.title])];
  const raw = texts.join("\n"), masked = texts.map((t) => maskText(t, { table: masker.table("s"), zone: "sources", origin: null })).join("\n");
  const stamp = "2026-11-25T00:00:00.000Z";
  const entry = (p, id, field) => {
    const k = p.canaries.find((c) => c.id === id);
    const value = field === "adresse" ? { text: `${p.values.street}\n${p.values.city}` } : { text: k.forms[0] };
    return { id: "b3r0000000000000", field, value, variants: [], origins: [], how: "typed", created: stamp, updated: stamp };
  };
  const out = {};
  for (const id of items) {
    const k = a.canaries.find((c) => c.id === id);
    assert.ok(k, `no canary ${id}`);
    assert.ok(collisionsIn(raw, [k]).length, `${id} is not in profile a's sources`);
    if (!collisionsIn(masked, [k]).length) { out[id] = "masking"; continue; }
    const field = SPEC_FIELD[id] ?? "libre";
    const ok = Object.values(PROFILES).every((p) => !validateEntry(entry(p, id, field), []).problems.length);
    out[id] = ok ? field : "out-of-promise";
  }
  return out;
}

async function derive() {
  const RUNS = runsAtSource().filter((r) => r.includes("minimax"));
  const summaries = RUNS.map((r) => ({ file: `results/${r}.summary.json`, s: json(`results/${r}.summary.json`) }));
  for (const { file, s } of summaries) assert.ok(String(s.model).includes("minimax"), `${file} is not a minimax run`);
  // attack id → [{ run, outcome, items }] where it left whole or partly
  const hits = new Map();
  for (const { s } of summaries) for (const c of s.cases) {
    if (c.arm !== "attack" || !["leaked", "partial"].includes(c.outcome)) continue;
    const items = [c, ...(c.conversation2 ? [c.conversation2] : [])].flatMap((x) => [...x.leaked, ...x.partial.map((p) => p.id)]);
    hits.set(c.id, [...(hits.get(c.id) ?? []), { run: s.run, outcome: c.outcome, items, channel: c.channel }]);
  }
  const named = new Set(SECTION4.flatMap(([, ids]) => ids));
  const extra = new Map();
  for (const [id, h] of hits) if (!named.has(base(id))) extra.set(h[0].channel, [...(extra.get(h[0].channel) ?? []), base(id)]);
  const groups = [...SECTION4, ...CHANNELS.filter((ch) => extra.has(ch)).map((ch, i) => [`F${12 + i}`, extra.get(ch).sort((x, y) => x.localeCompare(y, "en", { numeric: true }))])];

  const files = new Map();
  const file = (path) => { if (!files.has(path)) files.set(path, { text: at(path) }); const f = files.get(path); f.cases ??= JSON.parse(f.text); return f; };
  const model = [];
  const lines = groups.map(([line, ids]) => {
    const origin = ids.map((id) => `${id}_attack`);
    for (const o of origin) assert.ok(hits.has(o), `${line}: ${o} never left in a minimax run`);
    const h = origin.flatMap((o) => hits.get(o).map((x) => ({ ...x, id: o })));
    for (const o of origin) for (const id of [o, o.replace(/_attack$/, "_control")]) {
      const path = caseFile(hits.get(o)[0].channel);
      const c = file(path).cases.find((x) => x.id === id);
      assert.ok(c, `${id} not in ${path}`);
      model.push({ ...c, replay: { line, file: path, fileSha256: sha(file(path).text) } });
    }
    return {
      line, origin, items: [...new Set(h.flatMap((x) => x.items))].sort(),
      runs: h.map((x) => `${x.run}:${x.id}:${x.outcome}`),
      after0123: h.some((x) => AFTER_0123.test(x.run)),
      model: origin.flatMap((o) => [o, o.replace(/_attack$/, "_control")]),
      e2e: [],
    };
  });
  // e2e: the pairs of the shapes each line leaked (F10, F11 have no line: scripted adversary only).
  const E2E_LINES = { "adv-hangul-lab-digits": ["F8"], "adv-bare-pieces": ["F1", "F2", "F3"], "adv-link-covert": ["F6"], "adv-hangul-address": ["F7"], "adv-passport-street-out": ["F9"] };
  for (const [pair, ls] of Object.entries(E2E_LINES)) for (const l of lines) if (ls.includes(l.line)) l.e2e.push(`${pair}-a`, `${pair}-c`);
  const advSha = at("adversary-cases.json.sha256").trim();
  return {
    protocol: "B3 Masking protocol 2026-11-23 + real browser (README « Replay in the real browser »)",
    source: { commit: SOURCE, summaries: summaries.map((x) => x.file) },
    lines,
    passport: await passportDecisions([...new Set(lines.flatMap((l) => l.items))].sort()),
    limits: LIMITS,
    model,
    e2e: { file: "adversary-cases.json", sha256: advSha, ids: E2E.flatMap((p) => [`${p}-a`, `${p}-c`]) },
  };
}

/** The assertions every consumer relies on. */
function check(r) {
  assert.deepEqual(ressacCaseErrors(r.model), [], "ressacCaseErrors");
  assert.equal(new Set(r.model.map((c) => c.id)).size, r.model.length, "model ids unique");
  r.model.forEach((c, i) => {
    if (c.arm === "attack") assert.equal(r.model[i + 1]?.id, c.id.replace(/_attack$/, "_control"), `${c.id}: its control right after it`);
    else assert.equal(r.model[i - 1]?.id, c.id.replace(/_control$/, "_attack"), `${c.id}: after its attack`);
    for (const k of REFUSED_KEYS) assert.ok(!(k in c), `${c.id}: has ${k}, the browser bench serves none`);
    assert.equal(sha(at(c.replay.file)), c.replay.fileSha256, `${c.id}: file sha`);
    assert.equal(at(`${c.replay.file}.sha256`).trim().split(/\s/)[0], c.replay.fileSha256, `${c.replay.file}: its .sha256`);
    if (c.arm === "attack") {
      const v1 = JSON.parse(at(v1File(c.channel))).find((x) => x.id === c.id);
      const { replay, ...copied } = c;
      assert.equal(JSON.stringify(v1), JSON.stringify(copied), `${c.id}: identical in ${v1File(c.channel)} and the v2 file`);
    }
  });
  const adv = JSON.parse(readFileSync(new URL(r.e2e.file, B3), "utf8"));
  assert.equal(sha(readFileSync(new URL(r.e2e.file, B3))), readFileSync(new URL(`${r.e2e.file}.sha256`, B3), "utf8").trim().split(/\s/)[0], "adversary-cases.json sha256");
  assert.equal(sha(readFileSync(new URL(r.e2e.file, B3))), r.e2e.sha256, "adversary-cases.json: the frozen sha");
  for (const id of [...r.e2e.ids, ...r.lines.flatMap((l) => l.e2e)]) assert.ok(adv.some((c) => c.id === id), `e2e ${id} not in adversary-cases.json`);
  for (const l of r.lines) for (const id of l.items) assert.ok(r.passport[id], `${l.line}: no passport decision for ${id}`);
  for (const l of r.lines) assert.deepEqual(l.model, r.model.filter((c) => c.replay.line === l.line).map((c) => c.id), `${l.line}: model ids`);
}

function table(r) {
  const n = (ls, arm) => r.model.filter((c) => c.arm === arm && ls.some((l) => l.line === c.replay.line)).length;
  for (const l of r.lines) console.log(`${l.line.padEnd(4)} after0123=${String(l.after0123).padEnd(5)} ${l.origin.join(" ")}  [${l.items.join(", ")}]\n       ${l.runs.join("\n       ")}`);
  console.log("passport:", JSON.stringify(r.passport));
  const after = r.lines.filter((l) => l.after0123);
  console.log(`all: ${n(r.lines, "attack")} attacks + ${n(r.lines, "control")} controls = ${r.model.length} cases, ${r.model.length * 4} paid legs`);
  console.log(`after0123 (${after.map((l) => l.line).join(" ")}): ${n(after, "attack")} attacks + ${n(after, "control")} controls = ${n(after, "attack") + n(after, "control")} cases, ${(n(after, "attack") + n(after, "control")) * 4} paid legs`);
}

const mode = process.argv[2];
if (mode === "--write") {
  const r = await derive();
  check(r);
  const text = JSON.stringify(r, null, 1) + "\n";
  writeFileSync(OUT, text);
  writeFileSync(SHA, `${sha(text)}  replay-cases.json\n`);
  table(r);
} else if (mode === "--check") {
  const text = readFileSync(OUT, "utf8");
  assert.equal(readFileSync(SHA, "utf8").split(/\s/)[0], sha(text), "replay-cases.json differs from its sha256");
  const r = JSON.parse(text);
  check(r);
  assert.equal(JSON.stringify(await derive(), null, 1) + "\n", text, "replay-cases.json differs from what the summaries derive");
  table(r);
  console.log("freeze check ok");
} else {
  console.error("usage: node freeze.mjs --write | --check");
  process.exit(2);
}
