import { randomUUID } from "node:crypto";
import type { Action } from "../../commun/api";
import {
  cleEspace,
  LARGEUR_AGENT_MAX,
  LARGEUR_AGENT_MIN,
  URL_APPLICATIONS,
  urlWorkflow,
  type EtatFenetre,
  type EtatNavigateur,
  type Favori,
  type IdEspace,
  type IdOnglet,
  type IdProfil,
  type Onglet,
} from "../../commun/modele";

const MAX_FERMES = 20;

/** Brouillon modifiable : chaque gestionnaire renvoie false pour laisser l'état inchangé (même référence). */
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
  const esp = a.espaceId ?? f.espaceActif;
  if (!d.espaces.some((e) => e.id === esp)) return null;
  const o = creerOnglet(d, genId, { fenetreId: f.id, espaceId: esp, url: a.url, ouvertParAgent: a.ouvertParAgent ?? false });
  const l = liste(f, esp);
  const i = a.apres ? l.indexOf(a.apres) : -1;
  l.splice(i >= 0 ? i + 1 : l.length, 0, o.id);
  if (a.activer ?? true) f.actif[esp] = o.id;
  return o;
}

/** Active la page interne `url` de la fenêtre (dans son espace) si elle est déjà ouverte, sinon l'ouvre. */
function ouvrirPageInterne(d: Brouillon, genId: () => string, fenetreId: string, url: string, titre: string): boolean {
  const f = fenetre(d, fenetreId);
  if (!f) return false;
  const espaces = [f.espaceActif, ...Object.keys(f.ordre).filter((x) => x !== f.espaceActif)];
  for (const esp of espaces) {
    const existant = liste(f, esp).find((id) => d.onglets[id]?.url === url);
    if (!existant) continue;
    const o = d.onglets[existant]!;
    if (f.espaceActif === esp && f.actif[esp] === existant && o.titre === titre) return false;
    // Le widget a pu être renommé depuis : le titre suit.
    o.titre = titre;
    f.actif[esp] = existant;
    f.espaceActif = esp;
    return true;
  }
  const o = ouvrir(d, genId, f, { url });
  if (o) o.titre = titre;
  return !!o;
}

/** Un onglet d'essentiel peut être affiché dans plusieurs espaces : les autres espaces le lâchent. */
function lacherAilleurs(f: EtatFenetre, o: Onglet) {
  for (const [esp, id] of Object.entries(f.actif)) if (id === o.id && esp !== o.espaceId) f.actif[esp] = null;
}

/** Un favori retiré : ses onglets liés redeviennent des onglets normaux, en fin de liste de leur espace. */
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

/** Transforme un onglet normal en onglet lié à un nouveau favori. */
function lierAFavori(d: Brouillon, genId: () => string, o: Onglet, type: "essentiel" | "epingle"): Favori {
  const favori: Favori = { id: genId(), url: o.url, titre: o.titre, favicon: o.favicon };
  o.lien = { type, id: favori.id };
  const f = fenetre(d, o.fenetreId);
  if (f) f.ordre[o.espaceId] = liste(f, o.espaceId).filter((x) => x !== o.id);
  return favori;
}

/** Le profil de connexion demandé : « nouveau » en crée un ; un profil inconnu donne null. */
function profilDemande(d: Brouillon, genId: () => string, profil: IdProfil): IdProfil | null {
  if (profil === "nouveau") {
    const id = genId();
    d.profils.push({ id });
    return id;
  }
  return d.profils.some((p) => p.id === profil) ? profil : null;
}

/** Un profil de connexion qu'aucun espace n'utilise plus disparaît, le profil par défaut compris. */
function retirerProfilsInutilises(d: Brouillon) {
  d.profils = d.profils.filter((p) => d.espaces.some((e) => e.profil === p.id));
}

/**
 * Un espace change de clé : chacun de ses onglets qu'un autre espace de l'ancienne clé affiche passe à cet espace
 * (le premier dans l'ordre des espaces), qui l'a vu sous cette clé ; l'espace changé le lâche.
 * Ainsi un onglet vu dans un espace privé ne devient jamais lisible parce qu'un autre espace cesse de l'être.
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

/** Un espace n'affiche l'onglet d'un autre espace (un essentiel) que s'ils ont la même clé. */
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
      if (l.length === liste(f, o.espaceId).length) return false; // onglet lié : pas dans la liste
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
      // Les pages émettent souvent les mêmes valeurs : rien de changé, rien à rediffuser.
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
      // Un essentiel a un seul onglet par fenêtre, partagé par les espaces de même clé (profil de connexion, privé) ;
      // un épinglé appartient à son espace.
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
        // Un essentiel venu de l'espace supprimé a disparu avec lui.
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
      // Ses onglets normaux restent récupérables (⇧⌘T) depuis la fenêtre restante, le plus récent en tête.
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
    // Une seule page Applications par fenêtre : on y revient (dans son espace) plutôt que d'en ouvrir une deuxième.
    case "ouvrirApplications":
      return ouvrirPageInterne(d, genId, a.fenetreId, URL_APPLICATIONS, "Applications");
    // De même, une seule page « Voir le workflow » par widget et par fenêtre.
    case "ouvrirWorkflow":
      return ouvrirPageInterne(d, genId, a.fenetreId, urlWorkflow(a.id), `Workflow — ${a.nom}`);
    // Ouvrir le panneau sur un onglet le donne à l'agent : la page d'accueil ne l'ouvre que si elle est encore affichée.
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
  }
}

/** Seule façon de faire évoluer l'état : pure, ne mute jamais `etat`. */
export function appliquer(etat: EtatNavigateur, action: Action, genId: () => string = randomUUID): EtatNavigateur {
  const brouillon = structuredClone(etat);
  return gerer(brouillon, action, genId) ? brouillon : etat;
}
