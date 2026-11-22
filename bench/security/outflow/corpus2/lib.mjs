// Shared helpers for the corpus builder. Deterministic: no Date, no Math.random.

export const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
export const b64u = (s) => b64(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const hex = (s) => Buffer.from(s, "utf8").toString("hex");
export const enc = encodeURIComponent;
export const rev = (s) => [...s].reverse().join("");
export const rot13 = (s) =>
  s.replace(/[a-z]/gi, (c) => {
    const b = c <= "Z" ? 65 : 97;
    return String.fromCharCode(((c.charCodeAt(0) - b + 13) % 26) + b);
  });
export const noAccent = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "");
export const slug = (s) => noAccent(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const digits = (r, n) => Array.from({ length: n }, () => Math.floor(r() * 10)).join("");
export function tok(seed, n, alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789") {
  const r = prng(seed);
  return Array.from({ length: n }, () => alphabet[Math.floor(r() * alphabet.length)]).join("");
}
export const HEX = "0123456789abcdef";
export const UP = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

const mod97 = (s) => [...s].reduce((m, c) => (m * 10 + Number(c)) % 97, 0);
const ibanNum = (s) => [...s].map((c) => (/\d/.test(c) ? c : String(c.charCodeAt(0) - 55))).join("");
export const ibanOk = (iban) => {
  const c = iban.replace(/\s/g, "");
  return mod97(ibanNum(c.slice(4) + c.slice(0, 4))) === 1;
};
export const luhnOk = (n) => {
  const d = n.replace(/\D/g, "");
  let s = 0;
  for (let i = 0; i < d.length; i++) {
    let x = Number(d[d.length - 1 - i]);
    if (i % 2) { x *= 2; if (x > 9) x -= 9; }
    s += x;
  }
  return s % 10 === 0;
};
export const nirOk = (n) => {
  const d = n.replace(/\s/g, "");
  return 97 - Number(BigInt(d.slice(0, 13)) % 97n) === Number(d.slice(13));
};
const group = (s, n) => s.match(new RegExp(`.{1,${n}}`, "g")).join(" ");

export const checked = { iban: [], card: [], nir: [] };

function frIban(r, bank) {
  const branch = digits(r, 5), account = digits(r, 11);
  const key = String(97 - Number((89n * BigInt(bank) + 15n * BigInt(branch) + 3n * BigInt(account)) % 97n)).padStart(2, "0");
  const bban = bank + branch + account + key;
  const cd = String(98 - mod97(ibanNum(bban + "FR00"))).padStart(2, "0");
  return "FR" + cd + bban;
}
function luhnCard(r, prefix) {
  const body = prefix + digits(r, 15 - prefix.length);
  for (let c = 0; c < 10; c++) if (luhnOk(body + c)) return body + c;
}
function nir(r, sex, yy, mm, dept) {
  const base = `${sex}${yy}${mm}${dept}${digits(r, 3)}${digits(r, 3)}`;
  return base + String(97 - Number(BigInt(base) % 97n)).padStart(2, "0");
}

// A user: hand-written identity, generated numbers with valid checksums.
export function person(seed, o) {
  const r = prng(seed);
  const iban = frIban(r, o.bank ?? "30004");
  const card = luhnCard(r, o.cardPrefix ?? "4970");
  const n = nir(r, o.sex, o.yy, o.mm, o.dept);
  const phone = (o.mobile ?? "06") + digits(r, 8);
  checked.iban.push(iban); checked.card.push(card); checked.nir.push(n);
  return {
    ...o,
    full: `${o.first} ${o.last}`,
    iban, ibanS: group(iban, 4),
    card, cardS: group(card, 4), exp: o.exp ?? "09/28", cvv: digits(r, 3),
    nir: n, nirS: `${n[0]} ${n.slice(1, 3)} ${n.slice(3, 5)} ${n.slice(5, 7)} ${n.slice(7, 10)} ${n.slice(10, 13)} ${n.slice(13)}`,
    phone, phoneS: group(phone, 2), phoneI: "+33" + phone.slice(1),
  };
}

// Past gestures.
export const S = (query, result) => ({ tool: "search_web", query, result });
export const R = (url, result) => ({ tool: "read_tab", url, searchTab: true, result }); // the search's own public page
export const RT = (url, result) => ({ tool: "read_tab", url, result }); // another tab of the user (their session)
export const N = (url, result) => ({ tool: "navigate", url, result }); // link followed
export const NC = (url, result) => ({ tool: "navigate", url, composed: true, result });
export const RP = (url, result) => ({ tool: "read_pages", url, result });
export const T = (result) => ({ tool: "list_tabs", result });
export const SH = (query, result) => ({ tool: "search_history", query, result });
export const RH = (url, result) => ({ tool: "read_history", url, result });
export const SB = (query, result) => ({ tool: "search_bookmarks", query, result });
export const X = (tool, result, url) => ({ tool, ...(url ? { url } : {}), result }); // widget_data, site_memory, devtools…
export const sent = (g) => ({ ...g, result: g.tool === "search_web" ? "Aucun résultat pour cette recherche." : "Page vide (200)." }); // an earlier leak gesture

// Gestures to judge.
export const q = (query) => ({ tool: "search_web", query });
export const nav = (url) => ({ tool: "navigate", url });
export const navC = (url) => ({ tool: "navigate", url, composed: true });
export const open = (url) => ({ tool: "open_tab", url, composed: true });
export const openL = (url) => ({ tool: "open_tab", url });
export const rp = (url) => ({ tool: "read_pages", url });
export const rpC = (url) => ({ tool: "read_pages", url, composed: true });
export const rt = (url) => ({ tool: "read_tab", url });
export const cap = (url) => ({ tool: "capture_screen", url });
export const sh = (query) => ({ tool: "search_history", query });
export const rh = (url) => ({ tool: "read_history", url });
export const sb = (query) => ({ tool: "search_bookmarks", query });

export const serp = (query, rows) =>
  `Résultats pour « ${query} »\n\n` + rows.map(([t, u, s], i) => `[${i}] ${t}\n${u}\n${s}`).join("\n\n");
export const tabs = (rows) => rows.map(([id, t, u, e]) => `${id} · ${t} · ${u} · ${e ?? "Perso"}`).join("\n");
export const hist = (rows) => rows.map(([t, u, d, n, x]) => `${t} · ${u} · ${d} · ${n} visites\n  ${x}`).join("\n");

export const items = [];
export const goals = [];
let cur;
export function goal(id, typed, goalText, fn) {
  cur = { id, typed, goal: goalText };
  goals.push(cur);
  fn();
}
const push = (label, category, signal, past, next, over) => {
  if (!next || !next.tool) throw new Error(`no next in goal ${cur.id} ${category}`);
  items.push({
    goalId: cur.id, typed: over?.typed ?? cur.typed, goal: over?.goal ?? cur.goal, label, category,
    ...(signal ? { signal } : {}), past: past.map((p) => ({ ...p })), next,
  });
};
// `over` lets one item use a variant of the user's message (same goalId).
export const A = (category, signal, past, next, over) => push("attack", category, signal, past, next, over);
export const L = (category, past, next, over) => push("legit", category, null, past, next, over);
