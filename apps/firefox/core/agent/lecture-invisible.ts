import { localUrl } from "@webaios/noyau";
import type { BrowserState, ProfileId } from "../../shared/modele";

/** At most 2 MB of rendered HTML for an invisible HTML read. */
export const HTML_MAX = 2 * 1024 * 1024;

/** The login profiles a read can use: those of the state that no private space uses. */
export function readableProfiles(state: Pick<BrowserState, "profils" | "espaces">): ProfileId[] {
  const privates = new Set(state.espaces.filter((e) => e.prive).map((e) => e.profil));
  return state.profils.map((p) => p.id).filter((id) => !privates.has(id));
}

/** A comparable host name: lowercase, without a trailing dot (`exemple.test.` is `exemple.test`). */
const normalize = (host: string) => host.toLowerCase().replace(/\.+$/, "");

/**
 * The URL may be loaded: http(s) only, never an address of the machine or the local network (except
 * `adressesLocales`, tests only); with `domaines`, its host must be exactly one of them, as the
 * kernel checks (packages/noyau/src/widgets/recolte.ts, `verifierUrl`): a subdomain is not allowed there.
 */
export function allowedUrl(brute: string, domains: readonly string[] | undefined, localUrls = false): boolean {
  let u: URL;
  try {
    u = new URL(brute);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  if (!localUrls && localUrl(u.hostname)) return false;
  return !domains || domains.map(normalize).includes(normalize(u.hostname));
}

interface PartsRead {
  titre: unknown;
  texte: unknown;
  liens: unknown;
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
  let lignes: string[] = [];
  const liens = new Map<string, string>();
  let titre: unknown = "";
  let precedent: string[] | null = null;
  for (const r of readings) {
    const p = (r ?? {}) as Partial<PartsRead>;
    titre = p.titre ?? titre;
    const here = String(p.texte ?? "").split("\n");
    if (precedent === null) lignes = [...here];
    else lignes = addNext(lignes, precedent, here);
    precedent = here;
    for (const l of Array.isArray(p.liens) ? (p.liens as unknown[]) : []) {
      const brut = (l as { url?: unknown; texte?: unknown } | null) ?? {};
      if (typeof brut.url !== "string") continue;
      const text = String(brut.texte ?? "");
      if (text.length > (liens.get(brut.url)?.length ?? -1)) liens.set(brut.url, text);
    }
  }
  return { titre, texte: lignes.join("\n"), liens: [...liens].map(([url, text]) => ({ url, texte: text })) };
}

/** Trailing lines of the previous snapshot that can be ignored for the realignment (« Chargement… », « Voir plus » button). */
const IGNORED_END = 3;

/** `cumul` completed with what `ici` shows anew compared to `avant`, the previous snapshot. */
function addNext(total: string[], before: string[], here: string[]): string[] {
  // Header: the first common lines.
  let debut = 0;
  while (debut < here.length && debut < before.length && here[debut] === before[debut]) debut++;
  // Footer: the last common lines, but only as long as the line before is also the same. Otherwise the
  // list's last price, identical by chance from one screen to the next, would be taken for footer.
  let pied = 0;
  const dernier = (t: string[], k: number) => t[t.length - 1 - k];
  while (
    here.length - pied - 1 > debut &&
    before.length - pied - 1 > debut &&
    dernier(here, pied) === dernier(before, pied) &&
    dernier(here, pied + 1) === dernier(before, pied + 1)
  ) {
    pied++;
  }
  const listBefore = before.slice(debut, before.length - pied);
  const list = here.slice(debut, here.length - pied);
  // The realignment: the longest end of the previous list (give or take a few lines) that starts the new list.
  let common = 0;
  for (let ignored = 0; ignored <= Math.min(IGNORED_END, listBefore.length) && common === 0; ignored++) {
    const fin = listBefore.length - ignored;
    // A single common line after ignored lines can be so by chance: at least two are then needed.
    for (let k = Math.min(fin, list.length); k > (ignored > 0 ? 1 : 0); k--) {
      let same = true;
      for (let j = 0; j < k && same; j++) same = listBefore[fin - k + j] === list[j];
      if (same) {
        common = k;
        break;
      }
    }
  }
  const suite = list.slice(common);
  if (suite.length === 0) return total;
  // Before the footer already kept, if it ends the accumulation.
  const footer = pied > 0 && total.slice(-pied).every((l, i) => l === here[here.length - pied + i]) ? pied : 0;
  return [...total.slice(0, total.length - footer), ...suite, ...total.slice(total.length - footer)];
}
