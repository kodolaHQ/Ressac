import { format } from "../../shared/i18n";
import { RELEASE_NOTES } from "../../shared/release-notes";
import { customEngineError } from "../../shared/search";
import { cleanAgentDomains } from "../../shared/settings";
import { randomUUID } from "node:crypto";
import type { Action } from "../../shared/api";
import { DEFAULT_AURA } from "../../shared/aura";
import { bindingProblem, effectiveBindings, sameBinding } from "../../shared/shortcuts";
import {
  AGENT_PROFILE,
  spaceKey,
  AGENT_WIDTH_MAX,
  AGENT_WIDTH_MIN,
  BAR_WIDTH_MAX,
  BAR_WIDTH_MIN,
  actionOfUrl,
  recapOfUrl,
  urlRecap,
  privateTab,
  WORKFLOW_ACTION_PREFIX,
  URL_ACTIONS,
  URL_APPLICATIONS,
  URL_EXTENSIONS,
  URL_SETTINGS,
  URL_RELEASE_NOTES,
  urlAction,
  urlWorkflow,
  reviewUrl,
  type WindowState,
  type BrowserState,
  type Favorite,
  type SpaceId,
  type TabId,
  type ProfileId,
  type Tab,
} from "../../shared/model";

const MAX_CLOSED = 20;

/** Mutable draft: each handler returns false to leave the state unchanged (same reference). */
type Draft = BrowserState;

function win(d: Draft, id: string): WindowState | undefined {
  return d.windows.find((f) => f.id === id);
}

function newWindow(d: Draft, id: string, space: SpaceId): WindowState {
  return {
    id,
    activeSpace: space,
    order: Object.fromEntries(d.spaces.map((e) => [e.id, []])),
    active: Object.fromEntries(d.spaces.map((e) => [e.id, null])),
    compact: false,
    agentPanelOpen: false,
    recentlyClosed: [],
    frame: null,
  };
}

function list(f: WindowState, space: SpaceId): TabId[] {
  return (f.order[space] ??= []);
}

function createTab(d: Draft, genId: () => string, o: Partial<Tab> & Pick<Tab, "windowId" | "spaceId" | "url">): Tab {
  const tab: Tab = {
    id: genId(),
    title: o.url,
    favicon: null,
    link: null,
    openedByAgent: false,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    zoom: 1,
    crashed: false,
    error: null,
    ...o,
  };
  d.tabs[tab.id] = tab;
  return tab;
}

function open(
  d: Draft,
  genId: () => string,
  f: WindowState,
  a: { url: string; spaceId?: SpaceId; activate?: boolean; openedByAgent?: boolean; after?: TabId; title?: string; profile?: ProfileId },
): Tab | null {
  // A link opened from a tab stays in that tab's space (its login profile), even in the background;
  // an essential, shared between spaces, opens in the displayed space if it is the active tab there.
  const parent = a.after && f.active[f.activeSpace] !== a.after ? d.tabs[a.after]?.spaceId : undefined;
  const space = a.spaceId ?? parent ?? f.activeSpace;
  if (!d.spaces.some((e) => e.id === space)) return null;
  const o = createTab(d, genId, { windowId: f.id, spaceId: space, url: a.url, openedByAgent: a.openedByAgent ?? false, ...(a.title ? { title: a.title } : {}), ...(a.profile ? { profile: a.profile } : {}) });
  const l = list(f, space);
  const i = a.after ? l.indexOf(a.after) : -1;
  l.splice(i >= 0 ? i + 1 : l.length, 0, o.id);
  if (a.activate ?? true) f.active[space] = o.id;
  return o;
}

/** Activates the window's internal page `url` if already open in the active space, otherwise opens it there (never switches space). */
function openInternalPage(d: Draft, genId: () => string, windowId: string, url: string, title: string): boolean {
  const f = win(d, windowId);
  if (!f) return false;
  const space = f.activeSpace;
  const existing = list(f, space).find((id) => d.tabs[id]?.url === url);
  if (existing) {
    const o = d.tabs[existing]!;
    if (f.active[space] === existing && o.title === title) return false;
    // The widget may have been renamed since: the title follows.
    o.title = title;
    f.active[space] = existing;
    return true;
  }
  const o = open(d, genId, f, { url });
  if (o) o.title = title;
  return !!o;
}

/**
 * Activates the window's page of action `id` (tab whose URL is the action's, with or without execution) if it
 * is open in the active space, otherwise opens it there; never switches space, nothing in a private space.
 * `execution` changes the URL of that tab (a specific result).
 */
function openAction(d: Draft, genId: () => string, a: { windowId: string; id: string; name: string; run?: string }): boolean {
  const f = win(d, a.windowId);
  if (!f) return false;
  const space = f.activeSpace;
  if (d.spaces.find((e) => e.id === space)?.private !== false) return false;
  const existing = list(f, space).find((id) => actionOfUrl(d.tabs[id]?.url ?? "")?.id === a.id);
  if (existing) {
    const o = d.tabs[existing]!;
    const url = a.run ? urlAction(a.id, a.run) : o.url;
    if (f.active[space] === existing && o.title === a.name && o.url === url) return false;
    // The action may have been renamed since: the title follows.
    o.title = a.name;
    o.url = url;
    f.active[space] = existing;
    return true;
  }
  const o = open(d, genId, f, { url: urlAction(a.id, a.run) });
  if (o) o.title = a.name;
  return !!o;
}

/**
 * Activates the tab already showing recap `id` (any window, outside a private space; never switches space), otherwise
 * opens it in the window's active space; nothing when that space is private. The title follows a republish.
 */
function openRecap(d: Draft, genId: () => string, a: { windowId: string; id: string; title: string }): boolean {
  const f = win(d, a.windowId);
  if (!f || d.spaces.find((e) => e.id === f.activeSpace)?.private !== false) return false;
  const existing = Object.values(d.tabs).find((o) => recapOfUrl(o.url) === a.id && !privateTab(d, o));
  const g = existing && win(d, existing.windowId);
  if (existing && g) {
    if (g.active[existing.spaceId] === existing.id && existing.title === a.title) return false;
    existing.title = a.title;
    g.active[existing.spaceId] = existing.id;
    return true;
  }
  return !!open(d, genId, f, { url: urlRecap(a.id), title: a.title, openedByAgent: true });
}

/** An essential's tab can be displayed in several spaces: the other spaces release it. */
function dropElsewhere(f: WindowState, o: Tab) {
  for (const [space, id] of Object.entries(f.active)) if (id === o.id && space !== o.spaceId) f.active[space] = null;
}

/** A removed favorite: its linked tabs become normal tabs again, at the end of their space's list. */
function unlink(d: Draft, favoriteId: string) {
  for (const o of Object.values(d.tabs)) {
    if (o.link?.id !== favoriteId) continue;
    o.link = null;
    const f = win(d, o.windowId);
    if (!f) continue;
    list(f, o.spaceId).push(o.id);
    dropElsewhere(f, o);
  }
}

/** Turns a normal tab into a tab linked to a new favorite. */
function linkToFavorite(d: Draft, genId: () => string, o: Tab, type: "essential" | "pinned"): Favorite {
  const favorite: Favorite = { id: genId(), url: o.url, title: o.title, favicon: o.favicon };
  o.link = { type, id: favorite.id };
  const f = win(d, o.windowId);
  if (f) f.order[o.spaceId] = list(f, o.spaceId).filter((x) => x !== o.id);
  return favorite;
}

/** The requested login profile: "new" creates one; an unknown profile gives null. */
function requestedProfile(d: Draft, genId: () => string, profile: ProfileId): ProfileId | null {
  if (profile === AGENT_PROFILE) return null; // reserved for tabs
  if (profile === "new") {
    const id = genId();
    d.profiles.push({ id });
    return id;
  }
  return d.profiles.some((p) => p.id === profile) ? profile : null;
}

/** A login profile that no space uses anymore disappears, the default profile included. */
function removeUnusedProfiles(d: Draft) {
  d.profiles = d.profiles.filter((p) => d.spaces.some((e) => e.profile === p.id));
}

/**
 * A space changes key: each of its tabs that another space with the old key displays passes to that space
 * (the first in space order), which saw it under that key; the changed space releases it.
 * So a tab seen in a private space never becomes readable because another space stops being so.
 */
function forwardShown(d: Draft, spaceId: SpaceId, oldKey: string) {
  for (const f of d.windows)
    for (const o of Object.values(d.tabs)) {
      if (o.windowId !== f.id || o.spaceId !== spaceId) continue;
      const summarize = d.spaces.find(
        (e) => e.id !== spaceId && f.active[e.id] === o.id && spaceKey(d, e.id) === oldKey,
      );
      if (!summarize) continue;
      const l = list(f, spaceId);
      if (l.includes(o.id)) {
        f.order[spaceId] = l.filter((x) => x !== o.id);
        list(f, summarize.id).push(o.id);
      }
      o.spaceId = summarize.id;
      if (f.active[spaceId] === o.id) f.active[spaceId] = null;
    }
}

/** A space displays another space's tab (an essential) only if they have the same key. */
function dropIncompatible(d: Draft) {
  for (const f of d.windows)
    for (const [space, id] of Object.entries(f.active)) {
      const o = id ? d.tabs[id] : undefined;
      if (o && o.spaceId !== space && spaceKey(d, o.spaceId) !== spaceKey(d, space)) f.active[space] = null;
    }
}

/** Favorites given by address (an import): http(s) only, a URL already in `target` skipped. */
function addLinks(target: Favorite[], links: { url: string; title: string }[], genId: () => string): Favorite[] {
  for (const x of links) if (/^https?:\/\//.test(x.url) && !target.some((f) => f.url === x.url)) target.push({ id: genId(), url: x.url, title: x.title, favicon: null });
  return target;
}

function deleteTab(d: Draft, o: Tab) {
  const f = win(d, o.windowId);
  if (f) {
    const l = list(f, o.spaceId);
    const i = l.indexOf(o.id);
    if (i >= 0) l.splice(i, 1);
    if (f.active[o.spaceId] === o.id) f.active[o.spaceId] = (i >= 0 ? (l[i] ?? l[i - 1]) : l[0]) ?? null;
    dropElsewhere(f, o);
  }
  delete d.tabs[o.id];
}

function handle(d: Draft, a: Action, genId: () => string): boolean {
  switch (a.type) {
    case "openTab": {
      const f = win(d, a.windowId);
      return !!f && !!open(d, genId, f, a);
    }
    case "openTabs": {
      let changed = false;
      for (const t of a.tabs) changed = handle(d, t, genId) || changed;
      return changed;
    }
    case "closeTab": {
      const o = d.tabs[a.id];
      if (!o) return false;
      const f = win(d, o.windowId);
      if (f && !o.link) f.recentlyClosed = [{ url: o.url, spaceId: o.spaceId }, ...f.recentlyClosed].slice(0, MAX_CLOSED);
      deleteTab(d, o);
      return true;
    }
    case "activateTab": {
      const o = d.tabs[a.id];
      const f = o && win(d, o.windowId);
      if (!o || !f) return false;
      f.active[o.spaceId] = o.id;
      if (!a.keepSpace) f.activeSpace = o.spaceId;
      return true;
    }
    case "moveTab": {
      const o = d.tabs[a.id];
      const f = o && win(d, o.windowId);
      if (!o || !f) return false;
      const l = list(f, o.spaceId).filter((x) => x !== o.id);
      if (l.length === list(f, o.spaceId).length) return false; // linked tab: not in the list
      l.splice(Math.max(0, Math.min(a.index, l.length)), 0, o.id);
      f.order[o.spaceId] = l;
      return true;
    }
    case "reopenClosedTab": {
      const f = win(d, a.windowId);
      const [last, ...rest] = f?.recentlyClosed ?? [];
      if (!f || !last) return false;
      f.recentlyClosed = rest;
      const space = d.spaces.some((e) => e.id === last.spaceId) ? last.spaceId : f.activeSpace;
      open(d, genId, f, { url: last.url, spaceId: space });
      f.activeSpace = space;
      return true;
    }
    case "clearRecentlyClosed": {
      if (d.windows.every((f) => !f.recentlyClosed.length)) return false;
      for (const f of d.windows) f.recentlyClosed = [];
      return true;
    }
    case "updateTab": {
      const o = d.tabs[a.id];
      // Pages often emit the same values: nothing changed, nothing to rebroadcast.
      if (!o || unchanged(o, a.fields)) return false;
      Object.assign(o, a.fields);
      return true;
    }
    case "setCall": {
      const o = d.tabs[a.id];
      if (!o || (a.call === null ? !o.call : o.call?.mic === a.call.mic && o.call.camera === a.call.camera)) return false;
      if (a.call) o.call = a.call;
      else delete o.call;
      return true;
    }
    case "keepTab": {
      const o = d.tabs[a.id];
      // The agent's own profile is not the user's: those tabs are kept as a copy (TabList).
      if (!o?.openedByAgent || o.profile === AGENT_PROFILE) return false;
      o.openedByAgent = false;
      return true;
    }
    case "setAgentSearch": {
      const o = d.tabs[a.id];
      if (!o || (a.band === null ? !o.agentSearch : JSON.stringify(o.agentSearch) === JSON.stringify(a.band))) return false;
      if (a.band) o.agentSearch = a.band;
      else delete o.agentSearch;
      return true;
    }
    case "openFavorite": {
      const f = win(d, a.windowId);
      if (!f) return false;
      const favoriteSpace =
        a.kind === "essential" ? f.activeSpace : d.spaces.find((e) => e.pinned.some((x) => x.id === a.id))?.id;
      const favorite =
        a.kind === "essential"
          ? d.essentials.find((x) => x.id === a.id)
          : d.spaces.flatMap((e) => e.pinned).find((x) => x.id === a.id);
      if (!favorite || !favoriteSpace) return false;
      // An essential has a single tab per window, shared by spaces with the same key (login profile, private);
      // a pinned tab belongs to its space.
      const existing = Object.values(d.tabs).find(
        (o) =>
          o.windowId === f.id &&
          o.link?.id === favorite.id &&
          (a.kind === "essential" ? spaceKey(d, o.spaceId) === spaceKey(d, favoriteSpace) : o.spaceId === favoriteSpace),
      );
      const o =
        existing ??
        createTab(d, genId, {
          windowId: f.id,
          spaceId: favoriteSpace,
          url: favorite.url,
          title: favorite.title,
          favicon: favorite.favicon,
          link: { type: a.kind, id: favorite.id },
        });
      f.active[favoriteSpace] = o.id;
      f.activeSpace = favoriteSpace;
      return true;
    }
    case "pinTab": {
      const o = d.tabs[a.id];
      const space = o && d.spaces.find((e) => e.id === o.spaceId);
      if (!o || o.link || !space) return false;
      if (a.folderId && !space.folders.some((x) => x.id === a.folderId)) return false;
      space.pinned.push({ ...linkToFavorite(d, genId, o, "pinned"), ...(a.folderId ? { folder: a.folderId } : {}) });
      return true;
    }
    case "moveTabToSpace": {
      const o = d.tabs[a.id];
      const f = o && win(d, o.windowId);
      // A pinned tab or an essential belongs to its favorite: it does not move.
      if (!o || !f || o.link || o.spaceId === a.spaceId || !d.spaces.some((e) => e.id === a.spaceId)) return false;
      const l = list(f, o.spaceId);
      const i = l.indexOf(o.id);
      if (i >= 0) l.splice(i, 1);
      if (f.active[o.spaceId] === o.id) f.active[o.spaceId] = (i >= 0 ? (l[i] ?? l[i - 1]) : l[0]) ?? null;
      o.spaceId = a.spaceId;
      list(f, a.spaceId).push(o.id);
      // The space it lands in shows it if it had no tab.
      f.active[a.spaceId] ??= o.id;
      return true;
    }
    case "createFolder": {
      const space = d.spaces.find((e) => e.id === a.spaceId);
      const favorite = a.favoriteId ? space?.pinned.find((x) => x.id === a.favoriteId) : undefined;
      if (!space || (a.favoriteId && !favorite)) return false;
      const folder = { id: genId(), name: a.name, collapsed: false };
      space.folders.push(folder);
      if (favorite) favorite.folder = folder.id;
      return true;
    }
    case "renameFolder": {
      const folder = d.spaces.find((e) => e.id === a.spaceId)?.folders.find((x) => x.id === a.id);
      if (!folder || folder.name === a.name) return false;
      folder.name = a.name;
      return true;
    }
    case "renameFavorite": {
      const favorite = d.spaces.find((e) => e.id === a.spaceId)?.pinned.find((x) => x.id === a.favoriteId);
      if (!favorite || favorite.title === a.title) return false;
      favorite.title = a.title;
      return true;
    }
    case "deleteFolder": {
      const space = d.spaces.find((e) => e.id === a.spaceId);
      if (!space?.folders.some((x) => x.id === a.id)) return false;
      space.folders = space.folders.filter((x) => x.id !== a.id);
      for (const x of space.pinned) if (x.folder === a.id) delete x.folder;
      return true;
    }
    case "toggleFolder": {
      const folder = d.spaces.find((e) => e.id === a.spaceId)?.folders.find((x) => x.id === a.id);
      if (!folder) return false;
      folder.collapsed = !folder.collapsed;
      return true;
    }
    case "moveToFolder": {
      const space = d.spaces.find((e) => e.id === a.spaceId);
      const favorite = space?.pinned.find((x) => x.id === a.favoriteId);
      if (!space || !favorite || (favorite.folder ?? null) === a.folderId) return false;
      if (a.folderId === null) delete favorite.folder;
      else if (space.folders.some((x) => x.id === a.folderId)) favorite.folder = a.folderId;
      else return false;
      return true;
    }
    case "addEssential": {
      const o = d.tabs[a.id];
      if (!o || o.link) return false;
      d.essentials.push(linkToFavorite(d, genId, o, "essential"));
      return true;
    }
    case "unpin": {
      const space = d.spaces.find((e) => e.id === a.spaceId);
      if (!space?.pinned.some((x) => x.id === a.favoriteId)) return false;
      space.pinned = space.pinned.filter((x) => x.id !== a.favoriteId);
      unlink(d, a.favoriteId);
      return true;
    }
    case "removeEssential": {
      if (!d.essentials.some((x) => x.id === a.favoriteId)) return false;
      d.essentials = d.essentials.filter((x) => x.id !== a.favoriteId);
      unlink(d, a.favoriteId);
      return true;
    }
    case "unloadEssential": {
      const f = win(d, a.windowId);
      const tabs = Object.values(d.tabs).filter((o) => o.windowId === a.windowId && o.link?.type === "essential" && o.link.id === a.favoriteId && !o.unloaded);
      if (!f || !tabs.length) return false;
      for (const o of tabs) {
        // Its page closes: nothing of it is left to show (sound, call, load), and the spaces that displayed it move on.
        Object.assign(o, { unloaded: true, loading: false, crashed: false, error: null });
        delete o.sound;
        delete o.playback;
        delete o.call;
        for (const [space, id] of Object.entries(f.active)) if (id === o.id) f.active[space] = list(f, space)[0] ?? null;
      }
      return true;
    }
    case "moveEssential": {
      const from = d.essentials.findIndex((x) => x.id === a.favoriteId);
      const to = Math.max(0, Math.min(a.index, d.essentials.length - 1));
      if (from < 0 || from === to) return false;
      d.essentials.splice(to, 0, ...d.essentials.splice(from, 1));
      return true;
    }
    case "moveSpace": {
      const from = d.spaces.findIndex((x) => x.id === a.id);
      const to = Math.max(0, Math.min(a.index, d.spaces.length - 1));
      if (from < 0 || from === to) return false;
      d.spaces.splice(to, 0, ...d.spaces.splice(from, 1));
      return true;
    }
    case "addFavorites": {
      const space = a.spaceId === undefined ? null : d.spaces.find((e) => e.id === a.spaceId);
      if (space === undefined || space?.private) return false;
      const target = space ? space.pinned : d.essentials;
      const before = target.length;
      addLinks(target, a.favorites, genId);
      return target.length > before;
    }
    case "createSpace": {
      const profile = requestedProfile(d, genId, a.profile);
      if (!profile) return false;
      const space = genId();
      const pinned = addLinks([], a.pinned ?? [], genId);
      d.spaces.push({ id: space, name: a.name, icon: a.icon, pinned, folders: [], private: a.private, profile: profile, aura: a.aura ?? DEFAULT_AURA });
      for (const f of d.windows) {
        f.order[space] = [];
        f.active[space] = null;
      }
      const f = a.windowId ? win(d, a.windowId) : undefined;
      if (f) f.activeSpace = space;
      return true;
    }
    case "updateSpace": {
      const space = d.spaces.find((e) => e.id === a.id);
      if (!space) return false;
      if (space.name === a.name && space.icon === a.icon && space.private === a.private && space.profile === a.profile && (a.aura ?? space.aura) === space.aura) return false;
      const profile = requestedProfile(d, genId, a.profile);
      if (!profile) return false;
      const oldKey = spaceKey(d, space.id);
      Object.assign(space, { name: a.name, icon: a.icon, private: a.private, profile: profile, aura: a.aura ?? space.aura });
      if (spaceKey(d, space.id) !== oldKey) forwardShown(d, space.id, oldKey);
      removeUnusedProfiles(d);
      dropIncompatible(d);
      return true;
    }
    case "deleteSpace": {
      if (d.spaces.length <= 1 || !d.spaces.some((e) => e.id === a.id)) return false;
      d.spaces = d.spaces.filter((e) => e.id !== a.id);
      for (const o of Object.values(d.tabs)) if (o.spaceId === a.id) delete d.tabs[o.id];
      for (const f of d.windows) {
        delete f.order[a.id];
        delete f.active[a.id];
        // An essential coming from the deleted space disappeared with it.
        for (const [space, id] of Object.entries(f.active)) if (id && !d.tabs[id]) f.active[space] = null;
        f.recentlyClosed = f.recentlyClosed.filter((x) => x.spaceId !== a.id);
        if (f.activeSpace === a.id) f.activeSpace = d.spaces[0]!.id;
      }
      removeUnusedProfiles(d);
      return true;
    }
    case "activateSpace": {
      const f = win(d, a.windowId);
      if (!f || !d.spaces.some((e) => e.id === a.id)) return false;
      f.activeSpace = a.id;
      return true;
    }
    case "openWindow": {
      if (a.id && win(d, a.id)) return false;
      const space = a.spaceId && d.spaces.some((e) => e.id === a.spaceId) ? a.spaceId : d.spaces[0]!.id;
      d.windows.push(newWindow(d, a.id ?? genId(), space));
      return true;
    }
    case "moveTabToNewWindow": {
      const o = d.tabs[a.id];
      const f = o && win(d, o.windowId);
      // A pinned tab or an essential belongs to its favorite; a window's only tab would leave an empty window behind.
      if (!o || !f || o.link || (a.windowId && win(d, a.windowId)) || !Object.values(d.tabs).some((x) => x.windowId === f.id && !x.link && x.id !== o.id)) return false;
      const l = list(f, o.spaceId);
      const i = l.indexOf(o.id);
      if (i >= 0) l.splice(i, 1);
      if (f.active[o.spaceId] === o.id) f.active[o.spaceId] = (i >= 0 ? (l[i] ?? l[i - 1]) : l[0]) ?? null;
      const to = newWindow(d, a.windowId ?? genId(), o.spaceId);
      to.order[o.spaceId] = [o.id];
      to.active[o.spaceId] = o.id;
      to.compact = f.compact;
      to.frame = a.frame ?? null;
      d.windows.push(to);
      o.windowId = to.id;
      return true;
    }
    case "closeWindow": {
      const closed = win(d, a.id);
      if (d.windows.length <= 1 || !closed) return false;
      d.windows = d.windows.filter((f) => f.id !== a.id);
      // Its normal tabs move to the remaining window, in their order: closing a window never loses a tab.
      // Its favorite instances go, the favorites themselves stay.
      const remaining = d.windows[0]!;
      const moved = Object.values(closed.order).flat();
      for (const o of Object.values(d.tabs))
        if (o.windowId === a.id && !o.link && !moved.includes(o.id)) moved.push(o.id);
      for (const id of moved) {
        const o = d.tabs[id];
        if (!o || o.windowId !== a.id) continue;
        if (o.link) delete d.tabs[id];
        else {
          o.windowId = remaining.id;
          list(remaining, o.spaceId).push(id);
        }
      }
      for (const o of Object.values(d.tabs)) if (o.windowId === a.id) delete d.tabs[o.id];
      return true;
    }
    case "frameWindow": {
      const f = win(d, a.id);
      if (!f) return false;
      f.frame = a.frame;
      return true;
    }
    case "showBlankPage": {
      const f = win(d, a.windowId);
      if (!f || f.active[f.activeSpace] == null) return false;
      f.active[f.activeSpace] = null;
      return true;
    }
    case "toggleCompact": {
      const f = win(d, a.windowId);
      if (!f) return false;
      f.compact = !f.compact;
      return true;
    }
    case "toggleAgentPanel": {
      const f = win(d, a.windowId);
      if (!f) return false;
      f.agentPanelOpen = !f.agentPanelOpen;
      return true;
    }
    // A single Applications page per window: go back to it (in its space) rather than open a second one.
    case "openApps":
      return openInternalPage(d, genId, a.windowId, URL_APPLICATIONS, "Applications");
    case "openExtensions":
      return openInternalPage(d, genId, a.windowId, URL_EXTENSIONS, "Extensions");
    case "openSettings":
      return openInternalPage(d, genId, a.windowId, URL_SETTINGS, format(d.locale, "chrome-page-settings"));
    // Likewise, a single « Voir le workflow » page per widget and per window.
    case "openWorkflow":
      return openInternalPage(d, genId, a.windowId, a.owner === "action" ? WORKFLOW_ACTION_PREFIX + a.id : urlWorkflow(a.id), format(d.locale, "chrome-page-workflow", { name: a.name }));
    // A single page per action and per window (whatever result is shown), and a single « Actions » page.
    case "openAction":
      return openAction(d, genId, a);
    case "openRecap":
      return openRecap(d, genId, a);
    case "openActions":
      return openInternalPage(d, genId, a.windowId, URL_ACTIONS, "Actions");
    // Opening the panel on a tab gives it to the agent: the home page opens it only if it is still displayed.
    case "homeAgentPanel": {
      const f = win(d, a.windowId);
      if (!f || f.agentPanelOpen === a.open || (a.open && f.active[f.activeSpace])) return false;
      f.agentPanelOpen = a.open;
      return true;
    }
    case "chooseEngine": {
      const custom = a.custom?.trim() ?? d.settings.customEngine;
      // Checked here too: the chrome dispatches actions without parsing them.
      if (a.custom !== undefined && customEngineError(a.custom)) return false;
      if (a.engine === "custom" && (!custom || customEngineError(custom))) return false;
      if (d.settings.engine === a.engine && d.settings.customEngine === custom) return false;
      d.settings.engine = a.engine;
      d.settings.customEngine = custom;
      return true;
    }
    case "chooseAgentProfile": {
      if (d.settings.agentProfile === a.profile) return false;
      d.settings.agentProfile = a.profile;
      return true;
    }
    case "chooseAgentMode": {
      if (d.settings.agentMode === a.mode) return false;
      d.settings.agentMode = a.mode;
      return true;
    }
    case "chooseCodexEngine": {
      if (JSON.stringify(d.settings.codexEngine) === JSON.stringify(a.engine)) return false;
      d.settings.codexEngine = a.engine;
      return true;
    }
    case "chooseClaudeEngine": {
      if (JSON.stringify(d.settings.claudeEngine) === JSON.stringify(a.engine)) return false;
      d.settings.claudeEngine = a.engine;
      return true;
    }
    case "finishOnboarding": {
      const aiChanged = a.ai !== undefined && d.settings.aiEnabled !== a.ai;
      if (d.settings.onboarded && !aiChanged && !d.aiSetup && !d.welcomeReplay) return false;
      d.settings.onboarded = true;
      d.welcomeReplay = false;
      // « Oui » in the welcome turns AI on at once (enableAi): the full welcome ends that setup too.
      d.aiSetup = false;
      if (a.ai !== undefined) d.settings.aiEnabled = a.ai;
      return true;
    }
    case "enableAi": {
      d.settings.aiEnabled = true;
      d.aiSetup = true;
      return true;
    }
    case "disableAi": {
      d.settings.aiEnabled = false;
      d.aiSetup = false;
      for (const f of d.windows) f.agentPanelOpen = false;
      return true;
    }
    case "finishAiSetup": {
      if (!d.aiSetup) return false;
      d.aiSetup = false;
      return true;
    }
    case "replayOnboarding": {
      d.settings.onboarded = false;
      d.welcomeReplay = true;
      return true;
    }
    case "noteVersion": {
      if (d.settings.seenVersion === a.version) return false;
      d.settings.seenVersion = a.version;
      // Not on a first launch (the welcome is still to come), nor for a version without notes.
      const f = d.windows[0];
      if (f && d.settings.onboarded && RELEASE_NOTES[0]?.version === a.version) openInternalPage(d, genId, f.id, URL_RELEASE_NOTES, format(d.locale, "chrome-page-release-notes"));
      return true;
    }
    case "setUpdate": {
      const old = d.update;
      const dismissed = !!old?.dismissed && old.version === a.update.version;
      if (old && old.phase === a.update.phase && old.version === a.update.version && old.progress === a.update.progress && old.dismissed === dismissed) return false;
      d.update = { ...a.update, dismissed };
      return true;
    }
    case "dismissUpdate": {
      if (!d.update || d.update.dismissed) return false;
      d.update.dismissed = true;
      return true;
    }
    case "openReleaseNotes":
      return openInternalPage(d, genId, a.windowId, URL_RELEASE_NOTES, format(d.locale, "chrome-page-release-notes"));
    case "markHintSeen": {
      if (d.settings.hints.seen.includes(a.id)) return false;
      d.settings.hints.seen.push(a.id);
      return true;
    }
    case "setHintsEnabled": {
      if (d.settings.hints.enabled === a.enabled) return false;
      d.settings.hints.enabled = a.enabled;
      return true;
    }
    case "chooseAgentDomains": {
      const domains = cleanAgentDomains(a.domains.map((x) => x.trim().toLowerCase()));
      if (domains.length === d.settings.agentDomains.length && domains.every((x, i) => x === d.settings.agentDomains[i])) return false;
      d.settings.agentDomains = domains;
      return true;
    }
    case "setVimMode": {
      if (d.settings.vimMode === a.enabled) return false;
      d.settings.vimMode = a.enabled;
      return true;
    }
    case "setShortcut": {
      const current = d.settings.shortcuts[a.id];
      if (bindingProblem(a.id, a.binding, effectiveBindings(d.settings.shortcuts)) || (current && sameBinding(current, a.binding))) return false;
      d.settings.shortcuts[a.id] = a.binding;
      return true;
    }
    case "resetShortcut": {
      if (!(a.id in d.settings.shortcuts)) return false;
      delete d.settings.shortcuts[a.id];
      return true;
    }
    case "resetShortcuts": {
      if (!Object.keys(d.settings.shortcuts).length) return false;
      d.settings.shortcuts = {};
      return true;
    }
    case "setStartOnHome": {
      if (d.settings.startOnHome === a.enabled) return false;
      d.settings.startOnHome = a.enabled;
      return true;
    }
    case "setAuraMotion": {
      if (d.settings.auraMotion === a.enabled) return false;
      d.settings.auraMotion = a.enabled;
      return true;
    }
    case "chooseAppearance": {
      if (d.settings.appearance === a.appearance) return false;
      d.settings.appearance = a.appearance;
      return true;
    }
    case "chooseLanguage": {
      if (d.settings.language === a.language) return false;
      d.settings.language = a.language;
      return true;
    }
    case "setLocale": {
      if (d.locale === a.locale) return false;
      d.locale = a.locale;
      return true;
    }
    case "setSidebarSide": {
      if (d.settings.sidebarSide === a.side) return false;
      d.settings.sidebarSide = a.side;
      return true;
    }
    case "sidebarWidth": {
      const width = Math.round(Math.min(BAR_WIDTH_MAX, Math.max(BAR_WIDTH_MIN, a.width)));
      if (d.settings.sidebarWidth === width) return false;
      d.settings.sidebarWidth = width;
      return true;
    }
    case "agentPanelWidth": {
      const width = Math.round(Math.min(AGENT_WIDTH_MAX, Math.max(AGENT_WIDTH_MIN, a.width)));
      if (d.settings.agentPanelWidth === width) return false;
      d.settings.agentPanelWidth = width;
      return true;
    }
    // A single Review page per project and per window.
    case "openReview":
      return openInternalPage(d, genId, a.windowId, reviewUrl(a.project), format(d.locale, "chrome-page-review", { name: a.name }));
  }
}

/** The only way to evolve the state: pure, never mutates `state`. */
/**
 * Every essential keeps a tab in each window, for the login profile of the displayed space: it loads in the background
 * (at launch, once added, after its tab was closed) and opens at once. Not in a private space, where it opens on a click,
 * nor once the user unloaded it (unloadEssential): its tab stays, without a page, until it is displayed again.
 */
function keepEssentials(d: Draft, genId: () => string): boolean {
  let created = false;
  // One pass over the tabs, not one per window and essential: this runs after every action.
  const have = new Set<string>();
  for (const o of Object.values(d.tabs)) if (o.link) have.add(`${o.windowId}|${o.link.id}|${spaceKey(d, o.spaceId)}`);
  for (const f of d.windows) {
    // Displayed again, an unloaded essential loads.
    const shown = d.tabs[f.active[f.activeSpace] ?? ""];
    if (shown?.unloaded) delete shown.unloaded;
    const space = d.spaces.find((e) => e.id === f.activeSpace);
    if (!space || space.private) continue;
    const key = spaceKey(d, space.id);
    for (const e of d.essentials) {
      if (have.has(`${f.id}|${e.id}|${key}`)) continue;
      // Some callers give the id of the one tab their action opens: never reuse it.
      const id = genId();
      createTab(d, () => (d.tabs[id] ? randomUUID() : id), { windowId: f.id, spaceId: space.id, url: e.url, title: e.title, favicon: e.favicon, link: { type: "essential", id: e.id } });
      created = true;
    }
  }
  return created;
}

/** The loaded session with its essentials' tabs (see keepEssentials). */
export function withEssentials(state: BrowserState, genId: () => string = randomUUID): BrowserState {
  const draft = structuredClone(state);
  return keepEssentials(draft, genId) ? draft : state;
}

function unchanged(o: Tab, fields: Partial<Tab>): boolean {
  return Object.entries(fields).every(([k, v]) => (o[k as keyof Tab] ?? null) === (v ?? null));
}

export function apply(state: BrowserState, action: Action, genId: () => string = randomUUID): BrowserState {
  // updateTab fires on every title, icon and load event, mostly with the same values: no copy of the whole state for those.
  if (action.type === "updateTab" && (!state.tabs[action.id] || unchanged(state.tabs[action.id]!, action.fields))) return state;
  const draft = structuredClone(state);
  if (!handle(draft, action, genId)) return state;
  keepEssentials(draft, genId);
  return draft;
}
