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
  return d.fenetres.find((f) => f.id === id);
}

function list(f: WindowState, space: SpaceId): TabId[] {
  return (f.ordre[space] ??= []);
}

function createTab(d: Draft, genId: () => string, o: Partial<Tab> & Pick<Tab, "fenetreId" | "espaceId" | "url">): Tab {
  const tab: Tab = {
    id: genId(),
    titre: o.url,
    favicon: null,
    lien: null,
    ouvertParAgent: false,
    chargement: false,
    peutReculer: false,
    peutAvancer: false,
    zoom: 1,
    plante: false,
    erreur: null,
    ...o,
  };
  d.onglets[tab.id] = tab;
  return tab;
}

function open(
  d: Draft,
  genId: () => string,
  f: WindowState,
  a: { url: string; espaceId?: SpaceId; activer?: boolean; ouvertParAgent?: boolean; apres?: TabId },
): Tab | null {
  // A link opened from a tab stays in that tab's space (its login profile), even in the background;
  // an essential, shared between spaces, opens in the displayed space if it is the active tab there.
  const parent = a.apres && f.actif[f.espaceActif] !== a.apres ? d.onglets[a.apres]?.espaceId : undefined;
  const space = a.espaceId ?? parent ?? f.espaceActif;
  if (!d.espaces.some((e) => e.id === space)) return null;
  const o = createTab(d, genId, { fenetreId: f.id, espaceId: space, url: a.url, ouvertParAgent: a.ouvertParAgent ?? false });
  const l = list(f, space);
  const i = a.apres ? l.indexOf(a.apres) : -1;
  l.splice(i >= 0 ? i + 1 : l.length, 0, o.id);
  if (a.activer ?? true) f.actif[space] = o.id;
  return o;
}

/** Activates the window's internal page `url` (in its space) if already open, otherwise opens it. */
function openInternalPage(d: Draft, genId: () => string, windowId: string, url: string, title: string): boolean {
  const f = win(d, windowId);
  if (!f) return false;
  const spaces = [f.espaceActif, ...Object.keys(f.ordre).filter((x) => x !== f.espaceActif)];
  for (const space of spaces) {
    const existing = list(f, space).find((id) => d.onglets[id]?.url === url);
    if (!existing) continue;
    const o = d.onglets[existing]!;
    if (f.espaceActif === space && f.actif[space] === existing && o.titre === title) return false;
    // The widget may have been renamed since: the title follows.
    o.titre = title;
    f.actif[space] = existing;
    f.espaceActif = space;
    return true;
  }
  const o = open(d, genId, f, { url });
  if (o) o.titre = title;
  return !!o;
}

/**
 * Activates the window's page of action `id` (tab whose URL is the action's, with or without execution) if it
 * is open in a non-private space, otherwise opens it in the active space if not private. `execution` changes the URL
 * of that tab (a specific result).
 */
function openAction(d: Draft, genId: () => string, a: { fenetreId: string; id: string; nom: string; execution?: string }): boolean {
  const f = win(d, a.fenetreId);
  if (!f) return false;
  const notPrivate = (space: SpaceId) => d.espaces.find((e) => e.id === space)?.prive === false;
  const spaces = [f.espaceActif, ...Object.keys(f.ordre).filter((x) => x !== f.espaceActif)].filter(notPrivate);
  for (const space of spaces) {
    const existing = list(f, space).find((id) => actionOfUrl(d.onglets[id]?.url ?? "")?.id === a.id);
    if (!existing) continue;
    const o = d.onglets[existing]!;
    const url = a.execution ? urlAction(a.id, a.execution) : o.url;
    if (f.espaceActif === space && f.actif[space] === existing && o.titre === a.nom && o.url === url) return false;
    // The action may have been renamed since: the title follows.
    o.titre = a.nom;
    o.url = url;
    f.actif[space] = existing;
    f.espaceActif = space;
    return true;
  }
  if (!notPrivate(f.espaceActif)) return false;
  const o = open(d, genId, f, { url: urlAction(a.id, a.execution) });
  if (o) o.titre = a.nom;
  return !!o;
}

/** An essential's tab can be displayed in several spaces: the other spaces release it. */
function dropElsewhere(f: WindowState, o: Tab) {
  for (const [space, id] of Object.entries(f.actif)) if (id === o.id && space !== o.espaceId) f.actif[space] = null;
}

/** A removed favorite: its linked tabs become normal tabs again, at the end of their space's list. */
function unlink(d: Draft, favoriteId: string) {
  for (const o of Object.values(d.onglets)) {
    if (o.lien?.id !== favoriteId) continue;
    o.lien = null;
    const f = win(d, o.fenetreId);
    if (!f) continue;
    list(f, o.espaceId).push(o.id);
    dropElsewhere(f, o);
  }
}

/** Turns a normal tab into a tab linked to a new favorite. */
function linkToFavorite(d: Draft, genId: () => string, o: Tab, type: "essentiel" | "epingle"): Favorite {
  const favorite: Favorite = { id: genId(), url: o.url, titre: o.titre, favicon: o.favicon };
  o.lien = { type, id: favorite.id };
  const f = win(d, o.fenetreId);
  if (f) f.ordre[o.espaceId] = list(f, o.espaceId).filter((x) => x !== o.id);
  return favorite;
}

/** The requested login profile: « nouveau » creates one; an unknown profile gives null. */
function requestedProfile(d: Draft, genId: () => string, profile: ProfileId): ProfileId | null {
  if (profile === "nouveau") {
    const id = genId();
    d.profils.push({ id });
    return id;
  }
  return d.profils.some((p) => p.id === profile) ? profile : null;
}

/** A login profile that no space uses anymore disappears, the default profile included. */
function removeUnusedProfiles(d: Draft) {
  d.profils = d.profils.filter((p) => d.espaces.some((e) => e.profil === p.id));
}

/**
 * A space changes key: each of its tabs that another space with the old key displays passes to that space
 * (the first in space order), which saw it under that key; the changed space releases it.
 * So a tab seen in a private space never becomes readable because another space stops being so.
 */
function forwardShown(d: Draft, spaceId: SpaceId, oldKey: string) {
  for (const f of d.fenetres)
    for (const o of Object.values(d.onglets)) {
      if (o.fenetreId !== f.id || o.espaceId !== spaceId) continue;
      const summarize = d.espaces.find(
        (e) => e.id !== spaceId && f.actif[e.id] === o.id && spaceKey(d, e.id) === oldKey,
      );
      if (!summarize) continue;
      const l = list(f, spaceId);
      if (l.includes(o.id)) {
        f.ordre[spaceId] = l.filter((x) => x !== o.id);
        list(f, summarize.id).push(o.id);
      }
      o.espaceId = summarize.id;
      if (f.actif[spaceId] === o.id) f.actif[spaceId] = null;
    }
}

/** A space displays another space's tab (an essential) only if they have the same key. */
function dropIncompatible(d: Draft) {
  for (const f of d.fenetres)
    for (const [space, id] of Object.entries(f.actif)) {
      const o = id ? d.onglets[id] : undefined;
      if (o && o.espaceId !== space && spaceKey(d, o.espaceId) !== spaceKey(d, space)) f.actif[space] = null;
    }
}

function deleteTab(d: Draft, o: Tab) {
  const f = win(d, o.fenetreId);
  if (f) {
    const l = list(f, o.espaceId);
    const i = l.indexOf(o.id);
    if (i >= 0) l.splice(i, 1);
    if (f.actif[o.espaceId] === o.id) f.actif[o.espaceId] = (i >= 0 ? (l[i] ?? l[i - 1]) : l[0]) ?? null;
    dropElsewhere(f, o);
  }
  delete d.onglets[o.id];
}

function handle(d: Draft, a: Action, genId: () => string): boolean {
  switch (a.type) {
    case "ouvrirOnglet": {
      const f = win(d, a.fenetreId);
      return !!f && !!open(d, genId, f, a);
    }
    case "fermerOnglet": {
      const o = d.onglets[a.id];
      if (!o) return false;
      const f = win(d, o.fenetreId);
      if (f && !o.lien) f.fermesRecemment = [{ url: o.url, espaceId: o.espaceId }, ...f.fermesRecemment].slice(0, MAX_CLOSED);
      deleteTab(d, o);
      return true;
    }
    case "activerOnglet": {
      const o = d.onglets[a.id];
      const f = o && win(d, o.fenetreId);
      if (!o || !f) return false;
      f.actif[o.espaceId] = o.id;
      if (!a.garderEspace) f.espaceActif = o.espaceId;
      return true;
    }
    case "deplacerOnglet": {
      const o = d.onglets[a.id];
      const f = o && win(d, o.fenetreId);
      if (!o || !f) return false;
      const l = list(f, o.espaceId).filter((x) => x !== o.id);
      if (l.length === list(f, o.espaceId).length) return false; // linked tab: not in the list
      l.splice(Math.max(0, Math.min(a.index, l.length)), 0, o.id);
      f.ordre[o.espaceId] = l;
      return true;
    }
    case "rouvrirOngletFerme": {
      const f = win(d, a.fenetreId);
      const [last, ...rest] = f?.fermesRecemment ?? [];
      if (!f || !last) return false;
      f.fermesRecemment = rest;
      const space = d.espaces.some((e) => e.id === last.espaceId) ? last.espaceId : f.espaceActif;
      open(d, genId, f, { url: last.url, espaceId: space });
      f.espaceActif = space;
      return true;
    }
    case "majOnglet": {
      const o = d.onglets[a.id];
      // Pages often emit the same values: nothing changed, nothing to rebroadcast.
      if (!o || Object.entries(a.champs).every(([k, v]) => o[k as keyof Tab] === v)) return false;
      Object.assign(o, a.champs);
      return true;
    }
    case "ouvrirFavori": {
      const f = win(d, a.fenetreId);
      if (!f) return false;
      const favoriteSpace =
        a.genre === "essentiel" ? f.espaceActif : d.espaces.find((e) => e.epingles.some((x) => x.id === a.id))?.id;
      const favorite =
        a.genre === "essentiel"
          ? d.essentiels.find((x) => x.id === a.id)
          : d.espaces.flatMap((e) => e.epingles).find((x) => x.id === a.id);
      if (!favorite || !favoriteSpace) return false;
      // An essential has a single tab per window, shared by spaces with the same key (login profile, private);
      // a pinned tab belongs to its space.
      const existing = Object.values(d.onglets).find(
        (o) =>
          o.fenetreId === f.id &&
          o.lien?.id === favorite.id &&
          (a.genre === "essentiel" ? spaceKey(d, o.espaceId) === spaceKey(d, favoriteSpace) : o.espaceId === favoriteSpace),
      );
      const o =
        existing ??
        createTab(d, genId, {
          fenetreId: f.id,
          espaceId: favoriteSpace,
          url: favorite.url,
          titre: favorite.titre,
          favicon: favorite.favicon,
          lien: { type: a.genre, id: favorite.id },
        });
      f.actif[favoriteSpace] = o.id;
      f.espaceActif = favoriteSpace;
      return true;
    }
    case "epinglerOnglet": {
      const o = d.onglets[a.id];
      const space = o && d.espaces.find((e) => e.id === o.espaceId);
      if (!o || o.lien || !space) return false;
      space.epingles.push(linkToFavorite(d, genId, o, "epingle"));
      return true;
    }
    case "ajouterEssentiel": {
      const o = d.onglets[a.id];
      if (!o || o.lien) return false;
      d.essentiels.push(linkToFavorite(d, genId, o, "essentiel"));
      return true;
    }
    case "desepingler": {
      const space = d.espaces.find((e) => e.id === a.espaceId);
      if (!space?.epingles.some((x) => x.id === a.favoriId)) return false;
      space.epingles = space.epingles.filter((x) => x.id !== a.favoriId);
      unlink(d, a.favoriId);
      return true;
    }
    case "retirerEssentiel": {
      if (!d.essentiels.some((x) => x.id === a.favoriId)) return false;
      d.essentiels = d.essentiels.filter((x) => x.id !== a.favoriId);
      unlink(d, a.favoriId);
      return true;
    }
    case "creerEspace": {
      const profile = requestedProfile(d, genId, a.profil);
      if (!profile) return false;
      const space = genId();
      d.espaces.push({ id: space, nom: a.nom, icone: a.icone, epingles: [], prive: a.prive, profil: profile });
      for (const f of d.fenetres) {
        f.ordre[space] = [];
        f.actif[space] = null;
      }
      const f = a.fenetreId ? win(d, a.fenetreId) : undefined;
      if (f) f.espaceActif = space;
      return true;
    }
    case "reglerEspace": {
      const space = d.espaces.find((e) => e.id === a.id);
      if (!space) return false;
      if (space.nom === a.nom && space.icone === a.icone && space.prive === a.prive && space.profil === a.profil) return false;
      const profile = requestedProfile(d, genId, a.profil);
      if (!profile) return false;
      const oldKey = spaceKey(d, space.id);
      Object.assign(space, { nom: a.nom, icone: a.icone, prive: a.prive, profil: profile });
      if (spaceKey(d, space.id) !== oldKey) forwardShown(d, space.id, oldKey);
      removeUnusedProfiles(d);
      dropIncompatible(d);
      return true;
    }
    case "supprimerEspace": {
      if (d.espaces.length <= 1 || !d.espaces.some((e) => e.id === a.id)) return false;
      d.espaces = d.espaces.filter((e) => e.id !== a.id);
      for (const o of Object.values(d.onglets)) if (o.espaceId === a.id) delete d.onglets[o.id];
      for (const f of d.fenetres) {
        delete f.ordre[a.id];
        delete f.actif[a.id];
        // An essential coming from the deleted space disappeared with it.
        for (const [space, id] of Object.entries(f.actif)) if (id && !d.onglets[id]) f.actif[space] = null;
        f.fermesRecemment = f.fermesRecemment.filter((x) => x.espaceId !== a.id);
        if (f.espaceActif === a.id) f.espaceActif = d.espaces[0]!.id;
      }
      removeUnusedProfiles(d);
      return true;
    }
    case "activerEspace": {
      const f = win(d, a.fenetreId);
      if (!f || !d.espaces.some((e) => e.id === a.id)) return false;
      f.espaceActif = a.id;
      return true;
    }
    case "ouvrirFenetre": {
      const space = a.espaceId && d.espaces.some((e) => e.id === a.espaceId) ? a.espaceId : d.espaces[0]!.id;
      d.fenetres.push({
        id: a.id ?? genId(),
        espaceActif: space,
        ordre: Object.fromEntries(d.espaces.map((e) => [e.id, []])),
        actif: Object.fromEntries(d.espaces.map((e) => [e.id, null])),
        compact: false,
        panneauAgentOuvert: false,
        fermesRecemment: [],
        cadre: null,
      });
      return true;
    }
    case "fermerFenetre": {
      const closed = win(d, a.id);
      if (d.fenetres.length <= 1 || !closed) return false;
      d.fenetres = d.fenetres.filter((f) => f.id !== a.id);
      // Its normal tabs stay recoverable (⇧⌘T) from the remaining window, most recent first.
      const remaining = d.fenetres[0]!;
      const fetched = Object.values(closed.ordre)
        .flat()
        .map((id) => d.onglets[id])
        .filter((o) => !!o)
        .map((o) => ({ url: o.url, espaceId: o.espaceId }))
        .reverse();
      remaining.fermesRecemment = [...fetched, ...remaining.fermesRecemment].slice(0, MAX_CLOSED);
      for (const o of Object.values(d.onglets)) if (o.fenetreId === a.id) delete d.onglets[o.id];
      return true;
    }
    case "cadrerFenetre": {
      const f = win(d, a.id);
      if (!f) return false;
      f.cadre = a.cadre;
      return true;
    }
    case "afficherPageVide": {
      const f = win(d, a.fenetreId);
      if (!f || f.actif[f.espaceActif] == null) return false;
      f.actif[f.espaceActif] = null;
      return true;
    }
    case "basculerCompact": {
      const f = win(d, a.fenetreId);
      if (!f) return false;
      f.compact = !f.compact;
      return true;
    }
    case "basculerPanneauAgent": {
      const f = win(d, a.fenetreId);
      if (!f) return false;
      f.panneauAgentOuvert = !f.panneauAgentOuvert;
      return true;
    }
    // A single Applications page per window: go back to it (in its space) rather than open a second one.
    case "ouvrirApplications":
      return openInternalPage(d, genId, a.fenetreId, URL_APPLICATIONS, "Applications");
    case "ouvrirExtensions":
      return openInternalPage(d, genId, a.fenetreId, URL_EXTENSIONS, "Extensions");
    // Likewise, a single « Voir le workflow » page per widget and per window.
    case "ouvrirWorkflow":
      return openInternalPage(d, genId, a.fenetreId, a.proprietaire === "action" ? WORKFLOW_ACTION_PREFIX + a.id : urlWorkflow(a.id), `Workflow — ${a.nom}`);
    // A single page per action and per window (whatever result is shown), and a single « Actions » page.
    case "ouvrirAction":
      return openAction(d, genId, a);
    case "ouvrirActions":
      return openInternalPage(d, genId, a.fenetreId, URL_ACTIONS, "Actions");
    // Opening the panel on a tab gives it to the agent: the home page opens it only if it is still displayed.
    case "panneauAgentAccueil": {
      const f = win(d, a.fenetreId);
      if (!f || f.panneauAgentOuvert === a.ouvert || (a.ouvert && f.actif[f.espaceActif])) return false;
      f.panneauAgentOuvert = a.ouvert;
      return true;
    }
    case "choisirMoteur": {
      d.reglages.moteur = a.moteur;
      return true;
    }
    case "choisirProfilAgent": {
      if (d.reglages.profilAgent === a.profil) return false;
      d.reglages.profilAgent = a.profil;
      return true;
    }
    case "largeurPanneauAgent": {
      const width = Math.round(Math.min(AGENT_WIDTH_MAX, Math.max(AGENT_WIDTH_MIN, a.largeur)));
      if (d.reglages.largeurPanneauAgent === width) return false;
      d.reglages.largeurPanneauAgent = width;
      return true;
    }
    // A single Review page per project and per window.
    case "ouvrirRelecture":
      return openInternalPage(d, genId, a.fenetreId, reviewUrl(a.projet), `Relecture — ${a.nom}`);
  }
}

/** The only way to evolve the state: pure, never mutates `etat`. */
export function apply(state: BrowserState, action: Action, genId: () => string = randomUUID): BrowserState {
  const draft = structuredClone(state);
  return handle(draft, action, genId) ? draft : state;
}
