import { canonical, foldWords, splitName, validateEntry, type PassportValue } from "../shims/kernel";
import type { FoundAddress } from "./addresses";

export { splitName };

export type Proposal = { key: string; given: string; family: string; address: string; tel: string; email: string; ticked: boolean; other: boolean };
export type Draft = { field: "nom" | "proche" | "adresse" | "tel" | "email"; value: PassportValue };

const t = (s: string) => s.trim();

/** The draft passes the kernel's own check on its own (design § 4.2): what a card or a bar shows is what can be written. */
export const valid = (d: Draft): boolean => !validateEntry({ id: "", ...d, variants: [], origins: [], how: "import", created: "", updated: "" }, []).problems.length;

type Fields = { given: string; family: string; full: string; street: string; postcode: string; city: string; tel: string; email: string };

/** Loose address fields (an imported record, a typed form) to the shape of a proposal line, before the passport's own checks. */
export function fieldsToProposal(f: Fields) {
  const named = t(f.given) || t(f.family) ? { given: t(f.given), family: t(f.family) } : splitName(f.full);
  const street = t(f.street), rest = [t(f.postcode), t(f.city)].filter(Boolean).join(" ");
  return { ...named, address: street && rest ? `${street}\n${rest}` : "", tel: t(f.tel), email: t(f.email) };
}

/**
 * The proposal lines, plus for each proposal the indexes in `found` of the records merged into it that it keeps whole: a
 * record that loses a part here (half an address, a value the passport refuses) counts as incomplete and is never
 * among them, so it is never erased.
 */
export function proposeWithMembers(found: FoundAddress[]): { proposals: Proposal[]; incomplete: number; members: number[][] } {
  let incomplete = 0;
  const merged = new Map<string, { p: Omit<Proposal, "key" | "ticked" | "other">; usedAt: number; useCount: number; name: string; at: number[] }>();
  for (const [n, f] of found.entries()) {
    const raw = fieldsToProposal(f);
    const ok = new Set(drafts({ ...raw, key: "", ticked: true, other: false }, "me").filter(valid).map((d) => d.field));
    const p = { given: ok.has("nom") ? raw.given : "", family: ok.has("nom") ? raw.family : "", address: ok.has("adresse") ? raw.address : "", tel: ok.has("tel") ? raw.tel : "", email: ok.has("email") ? raw.email : "" };
    const lossy = !t(f.street) !== ![t(f.postcode), t(f.city)].some(Boolean) || (Object.keys(raw) as (keyof typeof raw)[]).some((k) => raw[k] !== p[k]);
    const empty = !p.given && !p.family && !p.address && !p.tel && !p.email;
    if (lossy || empty) incomplete++;
    if (empty) continue;
    const name = p.given || p.family ? canonical("nom", `${p.given} ${p.family}`) : "";
    const id = [name, foldWords(p.address), canonical("tel", p.tel), canonical("email", p.email)].join("|");
    const old = merged.get(id);
    const at = [...(old?.at ?? []), ...(lossy ? [] : [n])];
    if (!old || f.usedAt > old.usedAt) merged.set(id, { p, name, usedAt: f.usedAt, useCount: Math.max(f.useCount, old?.useCount ?? 0), at });
    else old.at = at;
  }
  const lines = [...merged.values()], ids = [...merged.keys()];
  // The user's name: on the most lines, then the most used.
  const score = new Map<string, [number, number]>();
  for (const l of lines) if (l.name) { const s = score.get(l.name) ?? [0, 0]; score.set(l.name, [s[0] + 1, s[1] + l.useCount]); }
  const me = [...score].sort(([, a], [, b]) => b[0] - a[0] || b[1] - a[1])[0]?.[0];
  const parts = (l: (typeof lines)[number]) => [l.p.address, l.p.tel, l.p.email].filter(Boolean).length;
  const best = lines.filter((l) => l.name === me).sort((a, b) => parts(b) - parts(a) || b.usedAt - a.usedAt || b.useCount - a.useCount)[0];
  return { proposals: lines.map((l, i) => ({ ...l.p, key: ids[i]!, ticked: l === best, other: !!l.name && l.name !== me })), incomplete, members: lines.map((l) => l.at) };
}

export function drafts(p: Proposal, as: "me" | "proche"): Draft[] {
  if (as === "proche") return [{ field: "proche", value: { given: p.given, family: p.family } }];
  const out: Draft[] = [];
  if (p.given || p.family) out.push({ field: "nom", value: { given: p.given, family: p.family } });
  if (p.address) out.push({ field: "adresse", value: { text: p.address } });
  if (p.tel) out.push({ field: "tel", value: { text: p.tel } });
  if (p.email) out.push({ field: "email", value: { text: p.email } });
  return out;
}
