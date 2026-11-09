import { randomUUID } from "node:crypto";
import type { Action } from "../../shared/api";
import {
  spaceKey,
  AGENT_WIDTH_MAX,
  AGENT_WIDTH_MIN,
  actionOfUrl,
  WORKFLOW_ACTION_PREFIX,
  URL_ACTIONS,
  URL_APPLICATIONS,
  URL_EXTENSIONS,
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
  a: { url: string; spaceId?: SpaceId; activate?: boolean; openedByAgent?: boolean; after?: TabId },
): Tab | null {
  // A link opened from a tab stays in that tab's space (its login profile), even in the background;
  // an essential, shared between spaces, opens in the displayed space if it is the active tab there.
  const parent = a.after && f.active[f.activeSpace] !== a.after ? d.tabs[a.after]?.spaceId : undefined;
  const space = a.spaceId ?? parent ?? f.activeSpace;
  if (!d.spaces.some((e) => e.id === space)) return null;
  const o = createTab(d, genId, { windowId: f.id, spaceId: space, url: a.url, openedByAgent: a.openedByAgent ?? false });
  const l = list(f, space);
  const i = a.after ? l.indexOf(a.after) : -1;
  l.splice(i >= 0 ? i + 1 : l.length, 0, o.id);
  if (a.activate ?? true) f.active[space] = o.id;
  return o;
}

/** Activates the window's internal page `url` (in its space) if already open, otherwise opens it. */
function openInternalPage(d: Draft, genId: () => string, windowId: string, url: string, title: string): boolean {
  const f = win(d, windowId);
  if (!f) return false;
  const spaces = [f.activeSpace, ...Object.keys(f.order).filter((x) => x !== f.activeSpace)];
  for (const space of spaces) {
    const existing = list(f, space).find((id) => d.tabs[id]?.url === url);
    if (!existing) continue;
    const o = d.tabs[existing]!;
    if (f.activeSpace === space && f.active[space] === existing && o.title === title) return false;
    // The widget may have been renamed since: the title follows.
    o.title = title;
    f.active[space] = existing;
    f.activeSpace = space;
    return true;
  }
  const o = open(d, genId, f, { url });
  if (o) o.title = title;
  return !!o;
}

/**
 * Activates the window's page of action `id` (tab whose URL is the action's, with or without execution) if it
 * is open in a non-private space, otherwise opens it in the active space if not private. `execution` changes the URL
 * of that tab (a specific result).
 */
function openAction(d: Draft, genId: () => string, a: { windowId: string; id: string; name: string; run?: string }): boolean {
  const f = win(d, a.windowId);
  if (!f) return false;
  const notPrivate = (space: SpaceId) => d.spaces.find((e) => e.id === space)?.private === false;
  const spaces = [f.activeSpace, ...Object.keys(f.order).filter((x) => x !== f.activeSpace)].filter(notPrivate);
  for (const space of spaces) {
    const existing = list(f, space).find((id) => actionOfUrl(d.tabs[id]?.url ?? "")?.id === a.id);
    if (!existing) continue;
    const o = d.tabs[existing]!;
    const url = a.run ? urlAction(a.id, a.run) : o.url;
    if (f.activeSpace === space && f.active[space] === existing && o.title === a.name && o.url === url) return false;
    // The action may have been renamed since: the title follows.
    o.title = a.name;
    o.url = url;
    f.active[space] = existing;
    f.activeSpace = space;
    return true;
  }
  if (!notPrivate(f.activeSpace)) return false;
  const o = open(d, genId, f, { url: urlAction(a.id, a.run) });
  if (o) o.title = a.name;
  return !!o;
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
function linkToFavorite(d: Draft, genId: () => string, o: Tab, type: "essentiel" | "epingle"): Favorite {
  const favorite: Favorite = { id: genId(), url: o.url, title: o.title, favicon: o.favicon };
  o.link = { type, id: favorite.id };
  const f = win(d, o.windowId);
  if (f) f.order[o.spaceId] = list(f, o.spaceId).filter((x) => x !== o.id);
  return favorite;
}

/** The requested login profile: « nouveau » creates one; an unknown profile gives null. */
function requestedProfile(d: Draft, genId: () => string, profile: ProfileId): ProfileId | null {
  if (profile === "nouveau") {
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
    case "ouvrirOnglet": {
      const f = win(d, a.windowId);
      return !!f && !!open(d, genId, f, a);
    }
    case "fermerOnglet": {
      const o = d.tabs[a.id];
      if (!o) return false;
      const f = win(d, o.windowId);
      if (f && !o.link) f.recentlyClosed = [{ url: o.url, spaceId: o.spaceId }, ...f.recentlyClosed].slice(0, MAX_CLOSED);
      deleteTab(d, o);
      return true;
    }
    case "activerOnglet": {
      const o = d.tabs[a.id];
      const f = o && win(d, o.windowId);
      if (!o || !f) return false;
      f.active[o.spaceId] = o.id;
      if (!a.keepSpace) f.activeSpace = o.spaceId;
      return true;
    }
    case "deplacerOnglet": {
      const o = d.tabs[a.id];
      const f = o && win(d, o.windowId);
      if (!o || !f) return false;
      const l = list(f, o.spaceId).filter((x) => x !== o.id);
      if (l.length === list(f, o.spaceId).length) return false; // linked tab: not in the list
      l.splice(Math.max(0, Math.min(a.index, l.length)), 0, o.id);
      f.order[o.spaceId] = l;
      return true;
    }
    case "rouvrirOngletFerme": {
      const f = win(d, a.windowId);
      const [last, ...rest] = f?.recentlyClosed ?? [];
      if (!f || !last) return false;
      f.recentlyClosed = rest;
      const space = d.spaces.some((e) => e.id === last.spaceId) ? last.spaceId : f.activeSpace;
      open(d, genId, f, { url: last.url, spaceId: space });
      f.activeSpace = space;
      return true;
    }
    case "majOnglet": {
      const o = d.tabs[a.id];
      // Pages often emit the same values: nothing changed, nothing to rebroadcast.
      if (!o || Object.entries(a.fields).every(([k, v]) => o[k as keyof Tab] === v)) return false;
      Object.assign(o, a.fields);
      return true;
    }
    case "ouvrirFavori": {
      const f = win(d, a.windowId);
      if (!f) return false;
      const favoriteSpace =
        a.kind === "essentiel" ? f.activeSpace : d.spaces.find((e) => e.pinned.some((x) => x.id === a.id))?.id;
      const favorite =
        a.kind === "essentiel"
          ? d.essentials.find((x) => x.id === a.id)
          : d.spaces.flatMap((e) => e.pinned).find((x) => x.id === a.id);
      if (!favorite || !favoriteSpace) return false;
      // An essential has a single tab per window, shared by spaces with the same key (login profile, private);
      // a pinned tab belongs to its space.
      const existing = Object.values(d.tabs).find(
        (o) =>
          o.windowId === f.id &&
          o.link?.id === favorite.id &&
          (a.kind === "essentiel" ? spaceKey(d, o.spaceId) === spaceKey(d, favoriteSpace) : o.spaceId === favoriteSpace),
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
    case "epinglerOnglet": {
      const o = d.tabs[a.id];
      const space = o && d.spaces.find((e) => e.id === o.spaceId);
      if (!o || o.link || !space) return false;
      space.pinned.push(linkToFavorite(d, genId, o, "epingle"));
      return true;
    }
    case "ajouterEssentiel": {
      const o = d.tabs[a.id];
      if (!o || o.link) return false;
      d.essentials.push(linkToFavorite(d, genId, o, "essentiel"));
      return true;
    }
    case "desepingler": {
      const space = d.spaces.find((e) => e.id === a.spaceId);
      if (!space?.pinned.some((x) => x.id === a.favoriteId)) return false;
      space.pinned = space.pinned.filter((x) => x.id !== a.favoriteId);
      unlink(d, a.favoriteId);
      return true;
    }
    case "retirerEssentiel": {
      if (!d.essentials.some((x) => x.id === a.favoriteId)) return false;
      d.essentials = d.essentials.filter((x) => x.id !== a.favoriteId);
      unlink(d, a.favoriteId);
      return true;
    }
    case "creerEspace": {
      const profile = requestedProfile(d, genId, a.profile);
      if (!profile) return false;
      const space = genId();
      d.spaces.push({ id: space, name: a.name, icon: a.icon, pinned: [], private: a.private, profile: profile });
      for (const f of d.windows) {
        f.order[space] = [];
        f.active[space] = null;
      }
      const f = a.windowId ? win(d, a.windowId) : undefined;
      if (f) f.activeSpace = space;
      return true;
    }
    case "reglerEspace": {
      const space = d.spaces.find((e) => e.id === a.id);
      if (!space) return false;
      if (space.name === a.name && space.icon === a.icon && space.private === a.private && space.profile === a.profile) return false;
      const profile = requestedProfile(d, genId, a.profile);
      if (!profile) return false;
      const oldKey = spaceKey(d, space.id);
      Object.assign(space, { name: a.name, icon: a.icon, private: a.private, profile: profile });
      if (spaceKey(d, space.id) !== oldKey) forwardShown(d, space.id, oldKey);
      removeUnusedProfiles(d);
      dropIncompatible(d);
      return true;
    }
    case "supprimerEspace": {
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
    case "activerEspace": {
      const f = win(d, a.windowId);
      if (!f || !d.spaces.some((e) => e.id === a.id)) return false;
      f.activeSpace = a.id;
      return true;
    }
    case "ouvrirFenetre": {
      const space = a.spaceId && d.spaces.some((e) => e.id === a.spaceId) ? a.spaceId : d.spaces[0]!.id;
      d.windows.push({
        id: a.id ?? genId(),
        activeSpace: space,
        order: Object.fromEntries(d.spaces.map((e) => [e.id, []])),
        active: Object.fromEntries(d.spaces.map((e) => [e.id, null])),
        compact: false,
        agentPanelOpen: false,
        recentlyClosed: [],
        frame: null,
      });
      return true;
    }
    case "fermerFenetre": {
      const closed = win(d, a.id);
      if (d.windows.length <= 1 || !closed) return false;
      d.windows = d.windows.filter((f) => f.id !== a.id);
      // Its normal tabs stay recoverable (⇧⌘T) from the remaining window, most recent first.
      const remaining = d.windows[0]!;
      const fetched = Object.values(closed.order)
        .flat()
        .map((id) => d.tabs[id])
        .filter((o) => !!o)
        .map((o) => ({ url: o.url, spaceId: o.spaceId }))
        .reverse();
      remaining.recentlyClosed = [...fetched, ...remaining.recentlyClosed].slice(0, MAX_CLOSED);
      for (const o of Object.values(d.tabs)) if (o.windowId === a.id) delete d.tabs[o.id];
      return true;
    }
    case "cadrerFenetre": {
      const f = win(d, a.id);
      if (!f) return false;
      f.frame = a.frame;
      return true;
    }
    case "afficherPageVide": {
      const f = win(d, a.windowId);
      if (!f || f.active[f.activeSpace] == null) return false;
      f.active[f.activeSpace] = null;
      return true;
    }
    case "basculerCompact": {
      const f = win(d, a.windowId);
      if (!f) return false;
      f.compact = !f.compact;
      return true;
    }
    case "basculerPanneauAgent": {
      const f = win(d, a.windowId);
      if (!f) return false;
      f.agentPanelOpen = !f.agentPanelOpen;
      return true;
    }
    // A single Applications page per window: go back to it (in its space) rather than open a second one.
    case "ouvrirApplications":
      return openInternalPage(d, genId, a.windowId, URL_APPLICATIONS, "Applications");
    case "ouvrirExtensions":
      return openInternalPage(d, genId, a.windowId, URL_EXTENSIONS, "Extensions");
    // Likewise, a single « Voir le workflow » page per widget and per window.
    case "ouvrirWorkflow":
      return openInternalPage(d, genId, a.windowId, a.owner === "action" ? WORKFLOW_ACTION_PREFIX + a.id : urlWorkflow(a.id), `Workflow — ${a.name}`);
    // A single page per action and per window (whatever result is shown), and a single « Actions » page.
    case "ouvrirAction":
      return openAction(d, genId, a);
    case "ouvrirActions":
      return openInternalPage(d, genId, a.windowId, URL_ACTIONS, "Actions");
    // Opening the panel on a tab gives it to the agent: the home page opens it only if it is still displayed.
    case "panneauAgentAccueil": {
      const f = win(d, a.windowId);
      if (!f || f.agentPanelOpen === a.open || (a.open && f.active[f.activeSpace])) return false;
      f.agentPanelOpen = a.open;
      return true;
    }
    case "choisirMoteur": {
      d.settings.engine = a.engine;
      return true;
    }
    case "choisirProfilAgent": {
      if (d.settings.agentProfile === a.profile) return false;
      d.settings.agentProfile = a.profile;
      return true;
    }
    case "largeurPanneauAgent": {
      const width = Math.round(Math.min(AGENT_WIDTH_MAX, Math.max(AGENT_WIDTH_MIN, a.width)));
      if (d.settings.agentPanelWidth === width) return false;
      d.settings.agentPanelWidth = width;
      return true;
    }
    // A single Review page per project and per window.
    case "ouvrirRelecture":
      return openInternalPage(d, genId, a.windowId, reviewUrl(a.project), `Relecture — ${a.name}`);
  }
}

/** The only way to evolve the state: pure, never mutates `etat`. */
export function apply(state: BrowserState, action: Action, genId: () => string = randomUUID): BrowserState {
  const draft = structuredClone(state);
  return handle(draft, action, genId) ? draft : state;
}
