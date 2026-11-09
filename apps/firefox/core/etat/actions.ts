import { randomUUID } from "node:crypto";
import type { Action } from "../../shared/api";
import {
  cleEspace,
  LARGEUR_AGENT_MAX,
  LARGEUR_AGENT_MIN,
  actionDeUrl,
  PREFIXE_WORKFLOW_ACTION,
  URL_ACTIONS,
  URL_APPLICATIONS,
  URL_EXTENSIONS,
  urlAction,
  urlWorkflow,
  urlRelecture,
  type EtatFenetre,
  type EtatNavigateur,
  type Favori,
  type IdEspace,
  type IdOnglet,
  type IdProfil,
  type Onglet,
} from "../../shared/modele";

const MAX_FERMES = 20;

/** Mutable draft: each handler returns false to leave the state unchanged (same reference). */
type Brouillon = EtatNavigateur;

function fenetre(d: Brouillon, id: string): EtatFenetre | undefined {
  return d.fenetres.find((f) => f.id === id);
}

function liste(f: EtatFenetre, esp: IdEspace): IdOnglet[] {
  return (f.ordre[esp] ??= []);
}

function creerOnglet(d: Brouillon, genId: () => string, o: Partial<Onglet> & Pick<Onglet, "fenetreId" | "espaceId" | "url">): Onglet {
  const onglet: Onglet = {
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
  d.onglets[onglet.id] = onglet;
  return onglet;
}

function ouvrir(
  d: Brouillon,
  genId: () => string,
  f: EtatFenetre,
  a: { url: string; espaceId?: IdEspace; activer?: boolean; ouvertParAgent?: boolean; apres?: IdOnglet },
): Onglet | null {
  // A link opened from a tab stays in that tab's space (its login profile), even in the background;
  // an essential, shared between spaces, opens in the displayed space if it is the active tab there.
  const parent = a.apres && f.actif[f.espaceActif] !== a.apres ? d.onglets[a.apres]?.espaceId : undefined;
  const esp = a.espaceId ?? parent ?? f.espaceActif;
  if (!d.espaces.some((e) => e.id === esp)) return null;
  const o = creerOnglet(d, genId, { fenetreId: f.id, espaceId: esp, url: a.url, ouvertParAgent: a.ouvertParAgent ?? false });
  const l = liste(f, esp);
  const i = a.apres ? l.indexOf(a.apres) : -1;
  l.splice(i >= 0 ? i + 1 : l.length, 0, o.id);
  if (a.activer ?? true) f.actif[esp] = o.id;
  return o;
}

/** Activates the window's internal page `url` (in its space) if already open, otherwise opens it. */
function ouvrirPageInterne(d: Brouillon, genId: () => string, fenetreId: string, url: string, titre: string): boolean {
  const f = fenetre(d, fenetreId);
  if (!f) return false;
  const espaces = [f.espaceActif, ...Object.keys(f.ordre).filter((x) => x !== f.espaceActif)];
  for (const esp of espaces) {
    const existant = liste(f, esp).find((id) => d.onglets[id]?.url === url);
    if (!existant) continue;
    const o = d.onglets[existant]!;
    if (f.espaceActif === esp && f.actif[esp] === existant && o.titre === titre) return false;
    // The widget may have been renamed since: the title follows.
    o.titre = titre;
    f.actif[esp] = existant;
    f.espaceActif = esp;
    return true;
  }
  const o = ouvrir(d, genId, f, { url });
  if (o) o.titre = titre;
  return !!o;
}

/**
 * Activates the window's page of action `id` (tab whose URL is the action's, with or without execution) if it
 * is open in a non-private space, otherwise opens it in the active space if not private. `execution` changes the URL
 * of that tab (a specific result).
 */
function ouvrirAction(d: Brouillon, genId: () => string, a: { fenetreId: string; id: string; nom: string; execution?: string }): boolean {
  const f = fenetre(d, a.fenetreId);
  if (!f) return false;
  const nonPrive = (esp: IdEspace) => d.espaces.find((e) => e.id === esp)?.prive === false;
  const espaces = [f.espaceActif, ...Object.keys(f.ordre).filter((x) => x !== f.espaceActif)].filter(nonPrive);
  for (const esp of espaces) {
    const existant = liste(f, esp).find((id) => actionDeUrl(d.onglets[id]?.url ?? "")?.id === a.id);
    if (!existant) continue;
    const o = d.onglets[existant]!;
    const url = a.execution ? urlAction(a.id, a.execution) : o.url;
    if (f.espaceActif === esp && f.actif[esp] === existant && o.titre === a.nom && o.url === url) return false;
    // The action may have been renamed since: the title follows.
    o.titre = a.nom;
    o.url = url;
    f.actif[esp] = existant;
    f.espaceActif = esp;
    return true;
  }
  if (!nonPrive(f.espaceActif)) return false;
  const o = ouvrir(d, genId, f, { url: urlAction(a.id, a.execution) });
  if (o) o.titre = a.nom;
  return !!o;
}

/** An essential's tab can be displayed in several spaces: the other spaces release it. */
function lacherAilleurs(f: EtatFenetre, o: Onglet) {
  for (const [esp, id] of Object.entries(f.actif)) if (id === o.id && esp !== o.espaceId) f.actif[esp] = null;
}

/** A removed favorite: its linked tabs become normal tabs again, at the end of their space's list. */
function delier(d: Brouillon, favoriId: string) {
  for (const o of Object.values(d.onglets)) {
    if (o.lien?.id !== favoriId) continue;
    o.lien = null;
    const f = fenetre(d, o.fenetreId);
    if (!f) continue;
    liste(f, o.espaceId).push(o.id);
    lacherAilleurs(f, o);
  }
}

/** Turns a normal tab into a tab linked to a new favorite. */
function lierAFavori(d: Brouillon, genId: () => string, o: Onglet, type: "essentiel" | "epingle"): Favori {
  const favori: Favori = { id: genId(), url: o.url, titre: o.titre, favicon: o.favicon };
  o.lien = { type, id: favori.id };
  const f = fenetre(d, o.fenetreId);
  if (f) f.ordre[o.espaceId] = liste(f, o.espaceId).filter((x) => x !== o.id);
  return favori;
}

/** The requested login profile: « nouveau » creates one; an unknown profile gives null. */
function profilDemande(d: Brouillon, genId: () => string, profil: IdProfil): IdProfil | null {
  if (profil === "nouveau") {
    const id = genId();
    d.profils.push({ id });
    return id;
  }
  return d.profils.some((p) => p.id === profil) ? profil : null;
}

/** A login profile that no space uses anymore disappears, the default profile included. */
function retirerProfilsInutilises(d: Brouillon) {
  d.profils = d.profils.filter((p) => d.espaces.some((e) => e.profil === p.id));
}

/**
 * A space changes key: each of its tabs that another space with the old key displays passes to that space
 * (the first in space order), which saw it under that key; the changed space releases it.
 * So a tab seen in a private space never becomes readable because another space stops being so.
 */
function transmettreAffiches(d: Brouillon, espaceId: IdEspace, ancienneCle: string) {
  for (const f of d.fenetres)
    for (const o of Object.values(d.onglets)) {
      if (o.fenetreId !== f.id || o.espaceId !== espaceId) continue;
      const repreneur = d.espaces.find(
        (e) => e.id !== espaceId && f.actif[e.id] === o.id && cleEspace(d, e.id) === ancienneCle,
      );
      if (!repreneur) continue;
      const l = liste(f, espaceId);
      if (l.includes(o.id)) {
        f.ordre[espaceId] = l.filter((x) => x !== o.id);
        liste(f, repreneur.id).push(o.id);
      }
      o.espaceId = repreneur.id;
      if (f.actif[espaceId] === o.id) f.actif[espaceId] = null;
    }
}

/** A space displays another space's tab (an essential) only if they have the same key. */
function lacherIncompatibles(d: Brouillon) {
  for (const f of d.fenetres)
    for (const [esp, id] of Object.entries(f.actif)) {
      const o = id ? d.onglets[id] : undefined;
      if (o && o.espaceId !== esp && cleEspace(d, o.espaceId) !== cleEspace(d, esp)) f.actif[esp] = null;
    }
}

function supprimerOnglet(d: Brouillon, o: Onglet) {
  const f = fenetre(d, o.fenetreId);
  if (f) {
    const l = liste(f, o.espaceId);
    const i = l.indexOf(o.id);
    if (i >= 0) l.splice(i, 1);
    if (f.actif[o.espaceId] === o.id) f.actif[o.espaceId] = (i >= 0 ? (l[i] ?? l[i - 1]) : l[0]) ?? null;
    lacherAilleurs(f, o);
  }
  delete d.onglets[o.id];
}

function gerer(d: Brouillon, a: Action, genId: () => string): boolean {
  switch (a.type) {
    case "ouvrirOnglet": {
      const f = fenetre(d, a.fenetreId);
      return !!f && !!ouvrir(d, genId, f, a);
    }
    case "fermerOnglet": {
      const o = d.onglets[a.id];
      if (!o) return false;
      const f = fenetre(d, o.fenetreId);
      if (f && !o.lien) f.fermesRecemment = [{ url: o.url, espaceId: o.espaceId }, ...f.fermesRecemment].slice(0, MAX_FERMES);
      supprimerOnglet(d, o);
      return true;
    }
    case "activerOnglet": {
      const o = d.onglets[a.id];
      const f = o && fenetre(d, o.fenetreId);
      if (!o || !f) return false;
      f.actif[o.espaceId] = o.id;
      if (!a.garderEspace) f.espaceActif = o.espaceId;
      return true;
    }
    case "deplacerOnglet": {
      const o = d.onglets[a.id];
      const f = o && fenetre(d, o.fenetreId);
      if (!o || !f) return false;
      const l = liste(f, o.espaceId).filter((x) => x !== o.id);
      if (l.length === liste(f, o.espaceId).length) return false; // linked tab: not in the list
      l.splice(Math.max(0, Math.min(a.index, l.length)), 0, o.id);
      f.ordre[o.espaceId] = l;
      return true;
    }
    case "rouvrirOngletFerme": {
      const f = fenetre(d, a.fenetreId);
      const [dernier, ...reste] = f?.fermesRecemment ?? [];
      if (!f || !dernier) return false;
      f.fermesRecemment = reste;
      const esp = d.espaces.some((e) => e.id === dernier.espaceId) ? dernier.espaceId : f.espaceActif;
      ouvrir(d, genId, f, { url: dernier.url, espaceId: esp });
      f.espaceActif = esp;
      return true;
    }
    case "majOnglet": {
      const o = d.onglets[a.id];
      // Pages often emit the same values: nothing changed, nothing to rebroadcast.
      if (!o || Object.entries(a.champs).every(([k, v]) => o[k as keyof Onglet] === v)) return false;
      Object.assign(o, a.champs);
      return true;
    }
    case "ouvrirFavori": {
      const f = fenetre(d, a.fenetreId);
      if (!f) return false;
      const espaceDuFavori =
        a.genre === "essentiel" ? f.espaceActif : d.espaces.find((e) => e.epingles.some((x) => x.id === a.id))?.id;
      const favori =
        a.genre === "essentiel"
          ? d.essentiels.find((x) => x.id === a.id)
          : d.espaces.flatMap((e) => e.epingles).find((x) => x.id === a.id);
      if (!favori || !espaceDuFavori) return false;
      // An essential has a single tab per window, shared by spaces with the same key (login profile, private);
      // a pinned tab belongs to its space.
      const existant = Object.values(d.onglets).find(
        (o) =>
          o.fenetreId === f.id &&
          o.lien?.id === favori.id &&
          (a.genre === "essentiel" ? cleEspace(d, o.espaceId) === cleEspace(d, espaceDuFavori) : o.espaceId === espaceDuFavori),
      );
      const o =
        existant ??
        creerOnglet(d, genId, {
          fenetreId: f.id,
          espaceId: espaceDuFavori,
          url: favori.url,
          titre: favori.titre,
          favicon: favori.favicon,
          lien: { type: a.genre, id: favori.id },
        });
      f.actif[espaceDuFavori] = o.id;
      f.espaceActif = espaceDuFavori;
      return true;
    }
    case "epinglerOnglet": {
      const o = d.onglets[a.id];
      const espace = o && d.espaces.find((e) => e.id === o.espaceId);
      if (!o || o.lien || !espace) return false;
      espace.epingles.push(lierAFavori(d, genId, o, "epingle"));
      return true;
    }
    case "ajouterEssentiel": {
      const o = d.onglets[a.id];
      if (!o || o.lien) return false;
      d.essentiels.push(lierAFavori(d, genId, o, "essentiel"));
      return true;
    }
    case "desepingler": {
      const espace = d.espaces.find((e) => e.id === a.espaceId);
      if (!espace?.epingles.some((x) => x.id === a.favoriId)) return false;
      espace.epingles = espace.epingles.filter((x) => x.id !== a.favoriId);
      delier(d, a.favoriId);
      return true;
    }
    case "retirerEssentiel": {
      if (!d.essentiels.some((x) => x.id === a.favoriId)) return false;
      d.essentiels = d.essentiels.filter((x) => x.id !== a.favoriId);
      delier(d, a.favoriId);
      return true;
    }
    case "creerEspace": {
      const profil = profilDemande(d, genId, a.profil);
      if (!profil) return false;
      const esp = genId();
      d.espaces.push({ id: esp, nom: a.nom, icone: a.icone, epingles: [], prive: a.prive, profil });
      for (const f of d.fenetres) {
        f.ordre[esp] = [];
        f.actif[esp] = null;
      }
      const f = a.fenetreId ? fenetre(d, a.fenetreId) : undefined;
      if (f) f.espaceActif = esp;
      return true;
    }
    case "reglerEspace": {
      const espace = d.espaces.find((e) => e.id === a.id);
      if (!espace) return false;
      if (espace.nom === a.nom && espace.icone === a.icone && espace.prive === a.prive && espace.profil === a.profil) return false;
      const profil = profilDemande(d, genId, a.profil);
      if (!profil) return false;
      const ancienneCle = cleEspace(d, espace.id);
      Object.assign(espace, { nom: a.nom, icone: a.icone, prive: a.prive, profil });
      if (cleEspace(d, espace.id) !== ancienneCle) transmettreAffiches(d, espace.id, ancienneCle);
      retirerProfilsInutilises(d);
      lacherIncompatibles(d);
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
        for (const [esp, id] of Object.entries(f.actif)) if (id && !d.onglets[id]) f.actif[esp] = null;
        f.fermesRecemment = f.fermesRecemment.filter((x) => x.espaceId !== a.id);
        if (f.espaceActif === a.id) f.espaceActif = d.espaces[0]!.id;
      }
      retirerProfilsInutilises(d);
      return true;
    }
    case "activerEspace": {
      const f = fenetre(d, a.fenetreId);
      if (!f || !d.espaces.some((e) => e.id === a.id)) return false;
      f.espaceActif = a.id;
      return true;
    }
    case "ouvrirFenetre": {
      const esp = a.espaceId && d.espaces.some((e) => e.id === a.espaceId) ? a.espaceId : d.espaces[0]!.id;
      d.fenetres.push({
        id: a.id ?? genId(),
        espaceActif: esp,
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
      const fermee = fenetre(d, a.id);
      if (d.fenetres.length <= 1 || !fermee) return false;
      d.fenetres = d.fenetres.filter((f) => f.id !== a.id);
      // Its normal tabs stay recoverable (⇧⌘T) from the remaining window, most recent first.
      const restante = d.fenetres[0]!;
      const recuperes = Object.values(fermee.ordre)
        .flat()
        .map((id) => d.onglets[id])
        .filter((o) => !!o)
        .map((o) => ({ url: o.url, espaceId: o.espaceId }))
        .reverse();
      restante.fermesRecemment = [...recuperes, ...restante.fermesRecemment].slice(0, MAX_FERMES);
      for (const o of Object.values(d.onglets)) if (o.fenetreId === a.id) delete d.onglets[o.id];
      return true;
    }
    case "cadrerFenetre": {
      const f = fenetre(d, a.id);
      if (!f) return false;
      f.cadre = a.cadre;
      return true;
    }
    case "afficherPageVide": {
      const f = fenetre(d, a.fenetreId);
      if (!f || f.actif[f.espaceActif] == null) return false;
      f.actif[f.espaceActif] = null;
      return true;
    }
    case "basculerCompact": {
      const f = fenetre(d, a.fenetreId);
      if (!f) return false;
      f.compact = !f.compact;
      return true;
    }
    case "basculerPanneauAgent": {
      const f = fenetre(d, a.fenetreId);
      if (!f) return false;
      f.panneauAgentOuvert = !f.panneauAgentOuvert;
      return true;
    }
    // A single Applications page per window: go back to it (in its space) rather than open a second one.
    case "ouvrirApplications":
      return ouvrirPageInterne(d, genId, a.fenetreId, URL_APPLICATIONS, "Applications");
    case "ouvrirExtensions":
      return ouvrirPageInterne(d, genId, a.fenetreId, URL_EXTENSIONS, "Extensions");
    // Likewise, a single « Voir le workflow » page per widget and per window.
    case "ouvrirWorkflow":
      return ouvrirPageInterne(d, genId, a.fenetreId, a.proprietaire === "action" ? PREFIXE_WORKFLOW_ACTION + a.id : urlWorkflow(a.id), `Workflow — ${a.nom}`);
    // A single page per action and per window (whatever result is shown), and a single « Actions » page.
    case "ouvrirAction":
      return ouvrirAction(d, genId, a);
    case "ouvrirActions":
      return ouvrirPageInterne(d, genId, a.fenetreId, URL_ACTIONS, "Actions");
    // Opening the panel on a tab gives it to the agent: the home page opens it only if it is still displayed.
    case "panneauAgentAccueil": {
      const f = fenetre(d, a.fenetreId);
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
      const largeur = Math.round(Math.min(LARGEUR_AGENT_MAX, Math.max(LARGEUR_AGENT_MIN, a.largeur)));
      if (d.reglages.largeurPanneauAgent === largeur) return false;
      d.reglages.largeurPanneauAgent = largeur;
      return true;
    }
    // A single Review page per project and per window.
    case "ouvrirRelecture":
      return ouvrirPageInterne(d, genId, a.fenetreId, urlRelecture(a.projet), `Relecture — ${a.nom}`);
  }
}

/** The only way to evolve the state: pure, never mutates `etat`. */
export function appliquer(etat: EtatNavigateur, action: Action, genId: () => string = randomUUID): EtatNavigateur {
  const brouillon = structuredClone(etat);
  return gerer(brouillon, action, genId) ? brouillon : etat;
}
