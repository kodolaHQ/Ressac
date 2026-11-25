import { canonical, foldWords, splitName, type PassportValue } from "../shims/kernel";
import type { FoundAddress } from "./addresses";

export { splitName };

export type Proposal = { key: string; given: string; family: string; address: string; tel: string; email: string; ticked: boolean; other: boolean };
export type Draft = { field: "nom" | "proche" | "adresse" | "tel" | "email"; value: PassportValue };

const t = (s: string) => s.trim();

export const propose = (found: FoundAddress[]): { proposals: Proposal[]; incomplete: number } => {
  const { proposals, incomplete } = proposeWithMembers(found);
  return { proposals, incomplete };
};

/** As `propose`, plus for each proposal the indexes in `found` of the records merged into it. */
export function proposeWithMembers(found: FoundAddress[]): { proposals: Proposal[]; incomplete: number; members: number[][] } {
  let incomplete = 0;
  const merged = new Map<string, { p: Omit<Proposal, "key" | "ticked" | "other">; usedAt: number; useCount: number; name: string; at: number[] }>();
  for (const [n, f] of found.entries()) {
    const named = t(f.given) || t(f.family) ? { given: t(f.given), family: t(f.family) } : splitName(f.full);
    const street = t(f.street), rest = [t(f.postcode), t(f.city)].filter(Boolean).join(" ");
    const address = street && rest ? `${street}\n${rest}` : "";
    const p = { ...named, address, tel: t(f.tel), email: t(f.email) };
    if (!p.given && !p.family && !address && !p.tel && !p.email) { incomplete++; continue; }
    const name = p.given || p.family ? canonical("nom", `${p.given} ${p.family}`) : "";
    const id = [name, foldWords(address), canonical("tel", p.tel), canonical("email", p.email)].join("|");
    const old = merged.get(id);
    const at = [...(old?.at ?? []), n];
    if (!old || f.usedAt > old.usedAt) merged.set(id, { p, name, usedAt: f.usedAt, useCount: Math.max(f.useCount, old?.useCount ?? 0), at });
    else old.at = at;
  }
  const lines = [...merged.values()];
  // The user's name: on the most lines, then the most used.
  const score = new Map<string, [number, number]>();
  for (const l of lines) if (l.name) { const s = score.get(l.name) ?? [0, 0]; score.set(l.name, [s[0] + 1, s[1] + l.useCount]); }
  const me = [...score].sort(([, a], [, b]) => b[0] - a[0] || b[1] - a[1])[0]?.[0];
  const parts = (l: (typeof lines)[number]) => [l.p.address, l.p.tel, l.p.email].filter(Boolean).length;
  const best = lines.filter((l) => l.name === me).sort((a, b) => parts(b) - parts(a) || b.usedAt - a.usedAt || b.useCount - a.useCount)[0];
  return { proposals: lines.map((l, i) => ({ ...l.p, key: `p${i}`, ticked: l === best, other: !!l.name && l.name !== me })), incomplete, members: lines.map((l) => l.at) };
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
