import type { Action } from "../../../shared/api";
import type { BrowserState } from "../../../shared/model";

export interface ImportedLink {
  url: string;
  title: string;
}

/** Another browser's sidebar: its spaces with their pinned tabs, and its favorites (→ essentials). */
export type ImportedSpaces = { spaces: { name: string; pinned: ImportedLink[] }[]; essentials: ImportedLink[] };

/** http(s) only, normalized so a re-import finds the same URL; null otherwise. */
function link(url: unknown, title: unknown): ImportedLink | null {
  if (typeof url !== "string") return null;
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return { url: u.href, title: typeof title === "string" && title ? title : u.host };
  } catch {
    return null;
  }
}

const isObject = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);

/** Arc's `[id, object, id, object…]` lists: the object following `key` (a string id, or an object matching it). */
function after(list: unknown, key: (v: unknown) => boolean): unknown {
  if (!Array.isArray(list)) return undefined;
  const i = list.findIndex(key);
  return i >= 0 ? list[i + 1] : undefined;
}

/**
 * Arc's `StorableSidebar.json`.
 * shortcut: the shape comes from public exporters (Arc is not installed where this was written): `sidebar.containers[]`,
 * the one holding `spaces` and `items` (each `[id, object…]`); a space's `containerIDs` has `"pinned"` then the pinned
 * container's id; `topAppsContainerIDs` has `{ default: true }` then the favorites container's id; an item is
 * `{ id, title, childrenIds, data.tab.savedURL/savedTitle }`, a folder has children. Measure it on a real Arc install.
 */
export function parseArcSidebar(json: unknown): ImportedSpaces | null {
  const containers = (json as { sidebar?: { containers?: unknown } })?.sidebar?.containers;
  if (!Array.isArray(containers)) return null;
  const c = containers.find((x) => isObject(x) && Array.isArray(x.spaces) && Array.isArray(x.items));
  if (!c) return null;
  const items = new Map<string, Record<string, any>>();
  for (const it of c.items) if (isObject(it) && typeof it.id === "string") items.set(it.id, it);
  /** The tabs under a container or folder, folders flattened. */
  const tabs = (id: unknown, seen = new Set<unknown>()): ImportedLink[] => {
    const it = typeof id === "string" ? items.get(id) : undefined;
    if (!it || seen.has(id)) return [];
    seen.add(id);
    const own = isObject(it.data?.tab) ? link(it.data.tab.savedURL, it.title || it.data.tab.savedTitle) : null;
    const children = Array.isArray(it.childrenIds) ? it.childrenIds.flatMap((x: unknown) => tabs(x, seen)) : [];
    return own ? [own, ...children] : children;
  };
  const spaces = c.spaces
    .filter((s: unknown) => isObject(s) && Array.isArray(s.containerIDs))
    .map((s: Record<string, any>) => ({
      name: typeof s.title === "string" && s.title.trim() ? s.title.trim() : "Arc",
      pinned: tabs(after(s.containerIDs, (x) => x === "pinned")),
    }));
  if (!spaces.length) return null;
  const essentials = tabs(after(c.topAppsContainerIDs, (x) => isObject(x) && x.default === true));
  return { spaces, essentials };
}

/**
 * Zen's `zen-sessions.jsonlz4` (decompressed), as measured on Zen 2026-11: `spaces[]` `{ uuid, name }`, and `tabs[]`
 * with `pinned`, `zenEssential`, `zenWorkspace` (a space's uuid), `zenIsGlance`, `entries[]` + `index` (1-based) and
 * `_zenPinnedInitialState.entry { url, title }`, the address the pin was made on.
 */
export function parseZenSpaces(session: unknown): ImportedSpaces | null {
  const s = session as { spaces?: unknown; tabs?: unknown };
  if (!isObject(s) || !Array.isArray(s.spaces) || !Array.isArray(s.tabs)) return null;
  const pins = s.tabs.filter((t): t is Record<string, any> => isObject(t) && t.pinned === true && t.zenIsGlance !== true);
  const linkOf = (t: Record<string, any>) => {
    const entries = Array.isArray(t.entries) ? t.entries : [];
    const e = isObject(t._zenPinnedInitialState?.entry) ? t._zenPinnedInitialState.entry : entries[(typeof t.index === "number" ? t.index : entries.length) - 1];
    return isObject(e) ? link(e.url, e.title) : null;
  };
  const links = (list: Record<string, any>[]) => list.flatMap((t) => linkOf(t) ?? []);
  const spaces = s.spaces
    .filter((w: unknown) => isObject(w) && typeof w.uuid === "string")
    .map((w: Record<string, any>) => ({
      name: typeof w.name === "string" && w.name.trim() ? w.name.trim() : "Zen",
      pinned: links(pins.filter((t) => t.zenEssential !== true && t.zenWorkspace === w.uuid)),
    }));
  return { spaces, essentials: links(pins.filter((t) => t.zenEssential === true)) };
}

/** `list` without the URLs in `present` nor repeats. */
function fresh(list: ImportedLink[], present: { url: string }[]): ImportedLink[] {
  const seen = new Set(present.map((f) => f.url));
  return list.filter((f) => !seen.has(f.url) && (seen.add(f.url), true));
}

/**
 * The store actions bringing `imported` in: a space of the same name (any case) is reused, unless it is private (a
 * new one is made then); a new space is normal, with the default aura, sharing the first normal space's login
 * profile. Nothing already there is added twice, nothing ever goes into a private space.
 */
export function planSpaceImport(state: BrowserState, imported: ImportedSpaces): Action[] {
  const actions: Action[] = [];
  const profile = state.spaces.find((e) => !e.private)?.profile ?? "new";
  const essentials = fresh(imported.essentials, state.essentials);
  if (essentials.length) actions.push({ type: "addFavorites", favorites: essentials });
  // Two imported spaces of the same name become one.
  const byName = new Map<string, { name: string; pinned: ImportedLink[] }>();
  for (const s of imported.spaces) {
    const key = s.name.toLowerCase();
    const prev = byName.get(key);
    if (prev) prev.pinned.push(...s.pinned);
    else byName.set(key, { name: s.name, pinned: [...s.pinned] });
  }
  for (const [key, s] of byName) {
    const space = state.spaces.find((e) => !e.private && e.name.toLowerCase() === key);
    const pinned = fresh(s.pinned, space?.pinned ?? []);
    if (!space) actions.push({ type: "createSpace", name: s.name, icon: "📁", private: false, profile, pinned });
    else if (pinned.length) actions.push({ type: "addFavorites", spaceId: space.id, favorites: pinned });
  }
  return actions;
}
