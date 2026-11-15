import { localUrl } from "@ressac/kernel";
import type { BrowserState, ProfileId } from "../../shared/model";

/** At most 2 MB of rendered HTML for an invisible HTML read. */
export const HTML_MAX = 2 * 1024 * 1024;

/** The login profiles a read can use: those of the state that no private space uses. */
export function readableProfiles(state: Pick<BrowserState, "profiles" | "spaces">): ProfileId[] {
  const privates = new Set(state.spaces.filter((e) => e.private).map((e) => e.profile));
  return state.profiles.map((p) => p.id).filter((id) => !privates.has(id));
}

/** A comparable host name: lowercase, without a trailing dot (`exemple.test.` is `exemple.test`). */
const normalize = (host: string) => host.toLowerCase().replace(/(?<!\.)\.+$/, "");

/**
 * The URL may be loaded: http(s) only, never an address of the machine or the local network (except
 * `adressesLocales`, tests only); with `domaines`, its host must be exactly one of them, as the
 * kernel checks (packages/kernel/src/widgets/recolte.ts, `checkUrl`): a subdomain is not allowed there.
 */
export function allowedUrl(raw: string, domains: readonly string[] | undefined, localUrls = false): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  if (!localUrls && localUrl(u.hostname)) return false;
  return !domains || domains.map(normalize).includes(normalize(u.hostname));
}

interface PartsRead {
  title: unknown;
  text: unknown;
  links: unknown;
}

/**
 * Merges the snapshots of a scrolled page. A virtualized list (Leboncoin) removes from the page the items that left
 * the screen: the final read shows only the last ones. Each snapshot is compared to the previous one: the common header and
 * footer are set aside, then the new snapshot's list is realigned on the end of the previous one's
 * (what they have in common), and only the new remainder is added, before the footer. Nothing is deduplicated
 * line by line: the same price or the same label from one item to the next stays. Links are merged by address, with
 * the longest text seen. The title is that of the final read. The caps then apply, at formatting.
 */
export function accumulateParts(readings: unknown[]): PartsRead {
  let lines: string[] = [];
  const links = new Map<string, string>();
  let title: unknown = "";
  let previous: string[] | null = null;
  for (const r of readings) {
    const p = (r ?? {}) as Partial<PartsRead>;
    title = p.title ?? title;
    const here = String(p.text ?? "").split("\n");
    if (previous === null) lines = [...here];
    else lines = addNext(lines, previous, here);
    previous = here;
    for (const l of Array.isArray(p.links) ? (p.links as unknown[]) : []) {
      const raw = (l as { url?: unknown; text?: unknown } | null) ?? {};
      if (typeof raw.url !== "string") continue;
      const text = String(raw.text ?? "");
      if (text.length > (links.get(raw.url)?.length ?? -1)) links.set(raw.url, text);
    }
  }
  return { title: title, text: lines.join("\n"), links: [...links].map(([url, text]) => ({ url, text: text })) };
}

/** Trailing lines of the previous snapshot that can be ignored for the realignment (« Chargement… », « Voir plus » button). */
const IGNORED_END = 3;

/** `cumul` completed with what `ici` shows anew compared to `avant`, the previous snapshot. */
function addNext(total: string[], before: string[], here: string[]): string[] {
  // Header: the first common lines.
  let start = 0;
  while (start < here.length && start < before.length && here[start] === before[start]) start++;
  // Footer: the last common lines, but only as long as the line before is also the same. Otherwise the
  // list's last price, identical by chance from one screen to the next, would be taken for footer.
  let pied = 0;
  const last = (t: string[], k: number) => t[t.length - 1 - k];
  while (
    here.length - pied - 1 > start &&
    before.length - pied - 1 > start &&
    last(here, pied) === last(before, pied) &&
    last(here, pied + 1) === last(before, pied + 1)
  ) {
    pied++;
  }
  const listBefore = before.slice(start, before.length - pied);
  const list = here.slice(start, here.length - pied);
  // The realignment: the longest end of the previous list (give or take a few lines) that starts the new list.
  let common = 0;
  for (let ignored = 0; ignored <= Math.min(IGNORED_END, listBefore.length) && common === 0; ignored++) {
    const end = listBefore.length - ignored;
    // A single common line after ignored lines can be so by chance: at least two are then needed.
    for (let k = Math.min(end, list.length); k > (ignored > 0 ? 1 : 0); k--) {
      let same = true;
      for (let j = 0; j < k && same; j++) same = listBefore[end - k + j] === list[j];
      if (same) {
        common = k;
        break;
      }
    }
  }
  const next = list.slice(common);
  if (next.length === 0) return total;
  // Before the footer already kept, if it ends the accumulation.
  const footer = pied > 0 && total.slice(-pied).every((l, i) => l === here[here.length - pied + i]) ? pied : 0;
  return [...total.slice(0, total.length - footer), ...next, ...total.slice(total.length - footer)];
}
