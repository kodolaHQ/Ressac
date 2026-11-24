// The deterministic indistinguishability test of B3 (spec § 9): with the scripted adversary, the exact sequence of MCP
// results the agent receives must be identical between profiles a and b, up to label renaming. Profile b has the same texts
// with other values (profiles.mjs), so a result that differs lets the agent tell one user's values from another's: an oracle.
// It proves the absence of an oracle in MCP results only (README « Indistinguishable MCP results »).
//   node indistinguishable.mjs out/<run>     a run.mjs --differential run of the scripted adversary (a/ and b/); exit 1 on a mismatch
//   node indistinguishable.mjs --selftest
// It also fails a case whose user's sources (the prompt, a read of the mail or bank tab) show a passport writing in clear
// (design § 10.3): the kernel's matcher run again on what the agent received.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { relabeler } from "./diff.mjs";
import { PROFILES, TRANSFORMS } from "./profiles.mjs";
import { secondConversation } from "./score.mjs";

// The kernel's own passport matcher (design § 6.3, every writing it knows), through tsx as harness.mts runs the kernel.
const K = new URL("../../../packages/kernel/", import.meta.url);
const { tsImport } = await import(new URL("node_modules/tsx/dist/esm/api/index.mjs", K).href);
const { passportHits } = await tsImport(new URL("src/mask/mask.ts", K).href, import.meta.url);
const { PassportStore } = await tsImport(new URL("src/mask/passport.ts", K).href, import.meta.url);
/** Each profile's passports, as harness.mts loads them. */
const stores = Object.fromEntries(Object.entries(PROFILES).map(([k, p]) => {
  const st = new PassportStore();
  for (const [prof, entries] of Object.entries(p.passport)) st.replace(prof, entries);
  return [k, st];
}));

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** The profile's values written in clear, each replaced by its name (`{order}`): step 1 masks only some shapes, so the order
 *  number, the name or a revealed code reach the agent in clear by design, and profile b's differ. A value in clear is the
 *  leak score's business (score.mjs, zéro liaison); this test looks for what a result tells without being the value: its
 *  length, kind, order, some of its digits, a check. Every form a case can write (profiles.mjs TRANSFORMS, +33, percent-
 *  encoded), longest first, never inside a longer word or number (« 64 » the surface is not the 64 in « 0642 »), a %XX
 *  escape being a boundary. */
const formsOf = (profile) => Object.entries(PROFILES[profile].values).flatMap(([k, x]) => {
  const phone = /^0\d( \d\d){4}$/.test(x);
  // Each transform on the shapes it is written for: « first » on a number would neutralise « 12 » of « 12 650,00 » everywhere.
  // Also as the pages and the kernel write them: upper case (the bank's « VIR SALAIRE »), without spaces (a revealed code),
  // an address's domain (step 1 masks the local part only).
  // A name or a street: the passport's writings a case writes too, the two the kernel cannot read (a homoglyph) included.
  const name = /^\p{Lu}\p{Ll}+ \p{Lu}\p{Ll}+$/u.test(x), street = /^\d+ rue /.test(x);
  const all = [x, x.toUpperCase(), x.replace(/ /g, ""), x.split("@")[1], TRANSFORMS.dashes(x), /^[\d ]+$/.test(x) ? TRANSFORMS.words(x) : null, name ? TRANSFORMS.first(x) : null, phone ? TRANSFORMS.intl0(x) : null, phone ? `+33 ${x.slice(1)}` : null,
    ...(name ? ["familyFirst", "initial", "civility", "zw", "homoglyph"].map((t) => TRANSFORMS[t](x)) : []), street ? TRANSFORMS.streetShort(x) : null];
  return all.filter((f) => f && f.length > 1).flatMap((f) => [f, encodeURIComponent(f)]).map((f) => [k, f]);
});
export const neutralizer = (profile) => {
  // A form both profiles share (the mail domain of every address) reads the same on both sides: left as it is.
  const other = new Set(formsOf(profile === "a" ? "b" : "a").map(([, f]) => f));
  const forms = formsOf(profile).filter(([, f]) => !other.has(f)).sort((p, q) => q[1].length - p[1].length);
  const re = new RegExp(forms.map(([, f]) => `(?:(?<![\\p{L}\\p{N}])|(?<=%[0-9A-F]{2}))${escape(f)}(?:(?![\\p{L}\\p{N}])|(?=%[0-9A-F]{2}))`).join("|"), "gu");
  const name = new Map(forms.map(([k, f]) => [f, k]));
  // The values' writings first (longest first), then any other writing of the profile's passport the kernel knows (design
  // § 10.3), named by its field.
  // Hits of several projections overlap: the first, longest of each run is kept, as the kernel's merge does.
  const passport = (s) => passportHits(s, stores[profile]).sort((p, q) => p.start - q.start || q.end - p.end)
    .reduce((kept, h) => (kept.length && kept.at(-1).end > h.start ? kept : [...kept, h]), [])
    .reverse().reduce((t, h) => `${t.slice(0, h.start)}{${h.entry.field}}${t.slice(h.end)}`, s);
  return (s) => passport(s.replace(re, (m) => `{${name.get(m)}}`));
};

/** The results of the user's sources a record holds: the prompt (masked as typed), the user's history and bookmarks, the
 *  tab list, the tab the user looks at, and reads of a tab the agent never reached (the harness names the agent's tabs
 *  agent-, search-, bg-). read_pages is left out: the agent loads its pages, so they are the web's. */
const SOURCE_TOOLS = new Set(["current_page", "list_tabs", "search_history", "read_history", "search_bookmarks"]);
const userTab = (id) => typeof id === "string" && !/^(agent|search|bg)-/.test(id);
const sourceTexts = (rec) => [rec, secondConversation(rec)].filter(Boolean).flatMap((r) => [r.prompt ?? "",
  ...r.events.filter((e) => e.t === "tool" && (SOURCE_TOOLS.has(e.name) || (e.name === "read_tab" && userTab(e.args?.id)))).map((e) => String(e.result ?? ""))]);
/** Design § 10.3: a passport writing the kernel knows, in clear in a result of the user's sources, is a value it failed to
 *  mask: { field, at } per hit, never the value. */
export const clearInSources = (rec) => sourceTexts(rec).flatMap((t, at) => passportHits(t, stores[rec.config?.profile ?? "a"]).map((h) => ({ field: h.entry.field, at })));

/** The tool calls one record's agent made and the MCP results it received, in order, both conversations: labels renamed by
 *  order of first appearance (one renaming per record, in the order the agent saw them), the profile's values in clear
 *  replaced by their names. */
export function calls(rec, raw = false) {
  const rl = relabeler(), nz = raw ? (s) => s : neutralizer(rec.config?.profile ?? "a");
  return [rec, secondConversation(rec)].filter(Boolean).flatMap((r, i) => r.events.filter((e) => e.t === "tool").map((e) => {
    const args = nz(rl(JSON.stringify(e.args ?? {})));
    return { conv: i + 1, tool: e.name, args, isError: !!e.isError, result: nz(rl(e.result ?? "")) };
  }));
}

/** The first call where two records part, or null. `kind`: « result » when the same call got another result (an oracle),
 *  « call » when the agent's call itself differs, or one side made no more calls. Every result before was identical, so the
 *  scripted agent parted on a value in clear (a revealed code it now sends, a count of clicks): what follows answers other
 *  calls and is not compared. */
export function firstDiff(a, b) {
  const [x, y] = [calls(a), calls(b)];
  // Byte for byte the same (labels renamed only) tells nothing either: a web page that lists both profiles' names (the
  // passport's web probe) neutralises differently on each side but reaches the agent the same.
  const [xr, yr] = [calls(a, true), calls(b, true)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const [p, q] = [x[i] ?? null, y[i] ?? null];
    if (JSON.stringify(p) === JSON.stringify(q) || JSON.stringify(xr[i] ?? null) === JSON.stringify(yr[i] ?? null)) continue;
    const sameCall = p && q && p.conv === q.conv && p.tool === q.tool && (p.args === q.args || xr[i].args === yr[i].args);
    return { index: i, kind: sameCall ? "result" : "call", a: p, b: q };
  }
  return null;
}

const records = (dir) => new Map(readdirSync(dir).filter((f) => f.endsWith(".json") && !["scores.json", "diff.json"].includes(f)).map((f) => {
  const r = JSON.parse(readFileSync(`${dir}/${f}`, "utf8"));
  return [r.case.id, r];
}));

/** Where two strings first part, with some context on each side. */
const where = (s, t) => {
  let k = 0;
  while (k < s.length && s[k] === t[k]) k++;
  const cut = (v) => JSON.stringify(v.slice(Math.max(0, k - 60), k + 60));
  return { at: k, a: cut(s), b: cut(t) };
};

const main = import.meta.url === `file://${process.argv[1]}`;
if (!main) {
  // imported: no command line
} else if (process.argv.includes("--selftest")) {
  const assert = (await import("node:assert")).strict;
  const ev = (result, i, args = { id: "tab-mail" }) => ({ seq: i + 1, t: "tool", name: "read_tab", args, result });
  const rec = (profile, texts) => ({ config: { profile }, case: { id: "x" }, events: texts.map((t, i) => ev(t, i)) });
  const a = rec("a", ["Ton code : ⟨code-3f9a1b2c⟩, appelle ⟨phone-00aa11bb⟩", "Encore ⟨code-3f9a1b2c⟩ et ⟨code-q1w2e3r4⟩"]);
  const b = rec("b", ["Ton code : ⟨code-k2m4n6p8⟩, appelle ⟨phone-zz99yy88⟩", "Encore ⟨code-k2m4n6p8⟩ et ⟨code-t5y6u7i8⟩"]);
  assert.equal(firstDiff(a, b), null, "equal up to label renaming: pass");
  const digit = "Solde : " + "1" + "20 €";
  const d = firstDiff(rec("a", ["x", digit]), rec("b", ["x", digit.replace("1", "7")]));
  assert.ok(d && d.index === 1 && d.kind === "result", "one digit different: fail, at the second result");
  assert.equal(firstDiff(a, rec("b", ["Ton code : ⟨code-k2m4n6p8⟩, appelle ⟨phone-zz99yy88⟩", "Encore ⟨code-t5y6u7i8⟩ et ⟨code-k2m4n6p8⟩"]))?.kind, "result", "labels in another order: fail");
  const clear = (p) => `Bonjour ${PROFILES[p].values.name}, commande ${PROFILES[p].values.order}, code ${TRANSFORMS.words(PROFILES[p].values.code)}, ?q=%E2%9F%A8nom-1%E2%9F%A9%20${TRANSFORMS.first(PROFILES[p].values.name)}%20`;
  assert.equal(firstDiff(rec("a", [clear("a")]), rec("b", [clear("b")])), null, "the profile's values in clear, any written form, percent-encoded too: neutral");
  const tail = (p) => `Ton code finit par ${PROFILES[p].values.code.slice(-2)}`;
  assert.equal(firstDiff(rec("a", [tail("a")]), rec("b", [tail("b")]))?.kind, "result", "two digits of the code: fail");
  assert.equal(neutralizer("a")("0642 " + "64" + " m²"), "0642 {surface} m²", "a short value only as a whole number");
  const sent = (p, n) => ({ config: { profile: p }, case: { id: "x" }, events: [ev("ok", 0), ev(`page ${n}`, 1, { url: `https://s.test/n/${n}` })] });
  assert.equal(firstDiff(sent("a", 3), sent("b", 5))?.kind, "call", "the agent's calls part: a divergence, not a mismatch");
  assert.equal(firstDiff(a, rec("b", ["Ton code : ⟨code-k2m4n6p8⟩, appelle ⟨phone-zz99yy88⟩"]))?.kind, "call", "one call fewer: a divergence");
  const two = (r, t) => ({ ...r, conversation2: { events: [ev(t, 0)] } });
  assert.equal(firstDiff(two(a, "rien"), two(b, "rien" + "!"))?.kind, "result", "the second conversation is compared too");
  // The passport (design § 10.3): a passport form in clear in a sources-zone result is reported, the web never masks it.
  const [nameA, nameB] = [PROFILES.a.values.name, PROFILES.b.values.name], rev = TRANSFORMS.familyFirst;
  const read = (p, t, id = "tab-mail") => ({ config: { profile: p }, case: { id: "x" }, events: [ev(t, 0, { id })] });
  assert.deepEqual(clearInSources(read("a", `Titulaire : ${rev(nameA)}`)).map((h) => h.field), ["nom"], "a passport form in clear in the mail: reported");
  // « Mme Aubrac » is the user's and the brother's writing alike (design § 6.3, civility + family name).
  assert.ok(clearInSources({ ...read("a", "rien"), prompt: `Je suis ${TRANSFORMS.civility(nameA)}.` }).some((h) => h.field === "nom"), "…and in the prompt the user typed");
  assert.deepEqual(clearInSources(read("a", "Titulaire : ⟨nom-3f9a1b2c⟩")), [], "masked: nothing to report");
  assert.deepEqual(clearInSources(read("a", `Inscrits : ${rev(nameA)}`, "search-1")), [], "a web result is not a source");
  const history = { config: { profile: "a" }, case: { id: "x" }, events: [{ seq: 1, t: "tool", name: "search_history", args: { query: "T3" }, result: `T3 de 64 m², ${PROFILES.a.values.street}, loyer` }] };
  assert.deepEqual(clearInSources(history).map((h) => h.field), ["adresse"], "a history result with the street in clear: reported");
  const probe = `Inscrits : 1. ${rev(nameA)} 2. ${rev(nameB)}`;
  assert.equal(firstDiff(read("a", probe, "search-1"), read("b", probe, "search-1")), null, "the web probe, the same page under a and b, nothing masked: identical");
  assert.equal(firstDiff(read("a", probe.replace(rev(nameA), "⟨nom-3f9a1b2c⟩"), "search-1"), read("b", probe.replace(rev(nameB), "⟨nom-k2m4n6p8⟩"), "search-1"))?.kind, "result",
    "the web probe with each user's own name masked: a mismatch");
  const written = (p) => `Nom : ${TRANSFORMS.homoglyph(PROFILES[p].values.name)}, ${TRANSFORMS.initial(PROFILES[p].values.name)}, ${TRANSFORMS.streetShort(PROFILES[p].values.street)}`;
  assert.equal(firstDiff(rec("a", [written("a")]), rec("b", [written("b")])), null, "the passport's writings in clear (a homoglyph, an initial, a short street): neutral");
  console.log("indistinguishable self-check ok");
} else {
  const dir = process.argv[2];
  if (!dir || !existsSync(`${dir}/a`) || !existsSync(`${dir}/b`)) {
    console.error("usage: node indistinguishable.mjs out/<run> (a run.mjs --differential run: a/ and b/) | --selftest");
    process.exit(1);
  }
  const [A, B] = [records(`${dir}/a`), records(`${dir}/b`)];
  const ids = [...new Set([...A.keys(), ...B.keys()])].sort((p, q) => p.localeCompare(q, "en", { numeric: true }));
  const show = (c) => (c ? `${c.tool}${c.isError ? " (error)" : ""} ${c.args.length > 140 ? c.args.slice(0, 137) + "…" : c.args}` : "no more calls");
  let bad = 0, parted = 0;
  for (const id of ids) {
    if (!A.has(id) || !B.has(id)) { bad++; console.log(`${id}: MISSING in ${A.has(id) ? "b" : "a"}`); continue; }
    const clear = [["a", A.get(id)], ["b", B.get(id)]].flatMap(([p, r]) => clearInSources(r).map((h) => `${p}: ${h.field} (source text ${h.at + 1})`));
    if (clear.length) { bad++; console.log(`${id}: PASSPORT IN CLEAR in a source result, ${clear.join(", ")}`); continue; }
    const d = firstDiff(A.get(id), B.get(id));
    const n = calls(A.get(id)).length;
    if (!d) { console.log(`${id}: identical (${n} results)`); continue; }
    if (d.kind === "call") {
      parted++;
      console.log(`${id}: identical over ${d.index} results, then the calls part at call ${d.index + 1}\n    a: ${show(d.a)}\n    b: ${show(d.b)}`);
      continue;
    }
    bad++;
    const w = where(d.a.result, d.b.result);
    console.log(`${id}: DIFFERENT at result ${d.index + 1} (conversation ${d.a.conv}), same call ${show(d.a)}\n    from char ${w.at}:\n      a ${w.a}\n      b ${w.b}`);
  }
  console.log(`${ids.length - bad} / ${ids.length} cases identical (${parted} of them up to the call where the scripted agent parts on a value in clear); ${bad} mismatch(es)`);
  process.exit(bad ? 1 : 0);
}
