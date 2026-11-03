<script lang="ts">
  import { tick, untrack } from "svelte";
  import type { EtatFenetre, Onglet } from "../../commun/modele";
  import { api, etat } from "../etat.svelte";
  import { fermerCommande, commande, focusPageVide } from "./commande.svelte";
  import {
    LIMITES,
    PARAMETRE_MAX,
    appliSourceDeProjet,
    appliSourceDeSite,
    demandeParametre,
    lignesCommande,
    parametreParDefaut,
    titreAvant,
    type AppliSource,
    type LigneCommande,
    type OngletSource,
    type SourcesCommande,
  } from "./commande";
  import { ongletsParcourables } from "../../commun/onglets-parcourables";
  import type { ActionAffichee } from "../../commun/actions";
  import type { Visite } from "../../commun/modele";
  import IconeSite from "./IconeSite.svelte";
  import Icone, { type NomIcone } from "./Icone.svelte";

  /**
   * Barre de commande (⌘T, ⌘L) : une boîte au-dessus de la page figée et floutée (FondFige, monté par App). Le champ est
   * monté tout de suite : la frappe qui suit le raccourci n'attend pas la capture.
   */
  let {
    fenetre,
    ongletActif,
    cede,
    fermerPanneau,
  }: {
    fenetre: EtatFenetre;
    ongletActif: Onglet | undefined;
    /** Le panneau ⌃Tab est ouvert par-dessus : il garde Échap. */
    cede: boolean;
    /** Ferme le panneau de l'interface (historique…) posé sur la page. */
    fermerPanneau: () => void;
  } = $props();

  // Les actions ne sont pas disponibles dans un espace privé (un espace introuvable compte comme privé), comme sur la page vide.
  const enPrive = $derived(etat.valeur?.espaces.find((e) => e.id === fenetre.espaceActif)?.prive ?? true);
  let actions = $state.raw<ActionAffichee[]>([]);
  let projets = $state.raw<AppliSource[]>([]);
  let sites = $state.raw<AppliSource[]>([]);
  let historique = $state.raw<Visite[]>([]);

  /** Relit une source au démarrage et à chacun de ses changements ; seule la dernière réponse compte. */
  function suivre<T>(lire: () => Promise<T>, poser: (v: T) => void, surChange: (rappel: () => void) => () => void): () => void {
    let derniere = 0;
    const charger = () => {
      const n = ++derniere;
      lire().then(
        (v) => n === derniere && poser(v),
        () => {},
      );
    };
    charger();
    return surChange(charger);
  }

  $effect(() => {
    if (enPrive) {
      actions = [];
      return;
    }
    return suivre(() => api.actions.liste(), (l) => (actions = l), (r) => api.actions.surChange(r));
  });
  $effect(() => suivre(() => api.applications.liste(), (l) => (projets = l.applications.map(appliSourceDeProjet).filter((a) => a !== null)), (r) => api.applications.surChange(r)));
  $effect(() => suivre(() => api.sites.liste(), (l) => (sites = l.map(appliSourceDeSite)), (r) => api.sites.surChange(r)));

  // Les onglets que l'espace actif affiche : même portée que ⌃Tab.
  const onglets = $derived.by<OngletSource[]>(() => {
    const e = etat.valeur;
    if (!e) return [];
    return ongletsParcourables(e, fenetre.id).flatMap((id) => {
      const o = e.onglets[id];
      return o ? [{ id: o.id, titre: o.titre, url: o.url, favicon: o.favicon }] : [];
    });
  });

  const sources: SourcesCommande = $derived({ actions, onglets, applis: [...projets, ...sites], historique });

  let texte = $state("");
  let refus = $state("");
  let requete = 0;

  // L'historique est redemandé à chaque frappe ; une réponse arrivée après une frappe plus récente est ignorée.
  $effect(() => {
    const t = texte.trim();
    const n = ++requete;
    if (!t) {
      historique = [];
      return;
    }
    api.historique.rechercher(t, LIMITES.historique, true).then(
      (v) => n === requete && (historique = v),
      () => n === requete && (historique = []),
    );
  });

  let choisieBrute = $state(0);
  let champ: HTMLInputElement | undefined = $state();

  /** Une action choisie qui attend sa saisie : la barre la demande dans un second champ, la liste se cache. */
  let parametre = $state<{ id: string; nom: string; libelle: string } | null>(null);
  let valeurParametre = $state("");
  let champParametre: HTMLInputElement | undefined = $state();

  const mode = $derived(commande.ouverte?.mode ?? "nouveau");
  const lignes: LigneCommande[] = $derived(lignesCommande(texte, sources, mode === "actif" ? (ongletActif?.url ?? null) : null, ongletActif?.id ?? null));
  // Une source arrivée tard peut raccourcir la liste : la sélection reste sur une ligne qui existe (la première sinon).
  const choisie = $derived(choisieBrute >= 0 && choisieBrute < lignes.length ? choisieBrute : 0);
  const choisir = (i: number) => (choisieBrute = i);

  // Une action lancée : une seconde Entrée ne la relance pas, et sa réponse arrivée après une fermeture ou une autre
  // ouverture (chacune est un nouvel objet) est ignorée.
  let actionEnCours = false;
  /** Change à chaque lancement et à chaque passage liste ↔ saisie : la réponse d'un lancement abandonné est ignorée. */
  let lancement = 0;

  // À chaque ouverture (la première, ou une réouverture dans l'autre mode) : saisie de départ, tout sélectionné en mode « actif ».
  $effect(() => {
    const o = commande.ouverte;
    if (!o) return;
    actionEnCours = false;
    parametre = null;
    texte = o.texte;
    choisieBrute = 0;
    refus = "";
    void tick().then(() => {
      champ?.focus();
      if (o.mode === "actif") champ?.select();
    });
  });

  /** Seule fonction qui agit : une ligne choisie (Entrée ou clic). */
  function executer(l: LigneCommande) {
    const cible = mode === "actif" ? (ongletActif?.id ?? null) : null;
    if (l.type === "defaut" && l.texte === "") {
      // Accueil : sans effet s'il est déjà affiché ; un panneau de l'interface posé dessus se referme.
      api.agir({ type: "afficherPageVide", fenetreId: fenetre.id });
      fermerPanneau();
      fermerCommande();
      // Déjà sur l'accueil, il n'est pas remonté : son champ reprend le clavier (et le prend en se montant sinon).
      focusPageVide.n++;
      return;
    }
    if (l.type === "action") {
      if (demandeParametre(l)) entrerParametre(l);
      else lancerAction(l.id, l.saisie);
      return;
    }
    if (l.type === "defaut") api.naviguer(cible, l.texte);
    else if (l.type === "historique") api.naviguer(cible, l.url);
    else if (l.type === "onglet") {
      // Comme la barre latérale et ⌃Tab : un essentiel s'ouvre par son favori (son onglet peut être celui d'un espace frère).
      const lien = etat.valeur?.onglets[l.onglet.id]?.lien;
      api.agir(lien?.type === "essentiel" ? { type: "ouvrirFavori", fenetreId: fenetre.id, genre: "essentiel", id: lien.id } : { type: "activerOnglet", id: l.onglet.id });
    } else if (l.appli.genre === "projet") api.applications.agir(l.appli.id, l.appli.action);
    else api.sites.agir(l.appli.id, "ouvrir");
    fermerCommande(true);
  }

  /** Ouvre la page de l'action et la lance avec `saisie` (sans saisie requise et absente : la page la demande). */
  function lancerAction(id: string, saisie: string | null) {
    if (actionEnCours) return;
    const o = commande.ouverte;
    const n = ++lancement;
    actionEnCours = true;
    refus = "";
    void api.actions.ouvrir(id, saisie).then(
      (r) => {
        if (o !== commande.ouverte || n !== lancement) return;
        actionEnCours = false;
        if (r.ok) fermerCommande();
        else refus = r.erreur;
      },
      () => {
        if (o !== commande.ouverte || n !== lancement) return;
        actionEnCours = false;
        refus = "Le service des actions ne répond pas";
      },
    );
  }

  /** Passe à la saisie de l'action, préremplie avec l'adresse de la page affichée, toute sélectionnée. */
  function entrerParametre(l: Extract<LigneCommande, { type: "action" }> & { parametre: string }) {
    lancement++;
    actionEnCours = false;
    parametre = { id: l.id, nom: l.nom, libelle: l.parametre };
    valeurParametre = defautParametre;
    refus = "";
    void tick().then(() => {
      champParametre?.focus();
      champParametre?.select();
    });
  }

  // La page affichée navigue pendant la saisie : l'adresse proposée suit, tant que l'utilisateur ne l'a pas retouchée.
  const defautParametre = $derived(parametreParDefaut(ongletActif?.url));
  let prerempli = "";
  $effect(() => {
    const d = defautParametre;
    untrack(() => {
      if (parametre && valeurParametre === prerempli && d !== prerempli) {
        valeurParametre = d;
        void tick().then(() => champParametre?.select());
      }
      prerempli = d;
    });
  });

  /** Revient à la liste, le texte tapé intact. */
  function sortirParametre() {
    lancement++;
    actionEnCours = false;
    parametre = null;
    refus = "";
    void tick().then(() => champ?.focus());
  }

  function toucheParametre(e: KeyboardEvent) {
    if (e.isComposing || !parametre) return;
    if (e.key === "Enter") {
      if (!e.repeat) lancerAction(parametre.id, valeurParametre.trim() || null);
    } else if (e.key === "Backspace" && valeurParametre === "") {
      // Une touche tenue efface le champ sans revenir à la liste (ni effacer ensuite le texte tapé).
      if (!e.repeat) sortirParametre();
    }
    else if (e.key !== "Tab") return;
    e.preventDefault();
    e.stopPropagation();
  }

  /**
   * Les touches que la barre traite s'arrêtent ici : les modales cachées dessous (demande de l'agent, réglages d'un
   * espace) écoutent la fenêtre et agiraient sinon sur ce qu'on ne voit pas. Tab et ⇧Tab ne font rien : le clavier
   * reste dans le champ, rien derrière le voile ne peut le prendre.
   */
  function touche(e: KeyboardEvent) {
    if (e.isComposing) return;
    if (e.key === "ArrowDown") choisir((choisie + 1) % Math.max(lignes.length, 1));
    else if (e.key === "ArrowUp") choisir((choisie - 1 + lignes.length) % Math.max(lignes.length, 1));
    else if (e.key === "Enter") {
      const l = lignes[choisie];
      if (l && !e.repeat) executer(l);
    } else if (e.key === "Tab") {
      // Tab sur une action qui attend sa saisie : on la donne tout de suite, comme Entrée.
      const l = lignes[choisie];
      if (l && demandeParametre(l) && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) entrerParametre(l);
    } else return;
    e.preventDefault();
    e.stopPropagation();
  }

  const libelle = (l: LigneCommande): string =>
    l.type === "defaut" ? l.libelle : l.type === "action" ? l.nom : l.type === "onglet" ? l.onglet.titre : l.type === "appli" ? l.appli.nom : l.titre || l.url;
  // L'historique ne retient pas de favicon : celui du site, à l'adresse habituelle (sauf visite privée, rien n'en sort).
  const faviconVisite = (url: string): string | null =>
    /^https?:\/\//i.test(url) && historique.some((v) => v.url === url && !v.prive) ? `${new URL(url).origin}/favicon.ico` : null;
  const favicon = (l: LigneCommande): string | null =>
    l.type === "onglet" ? l.onglet.favicon : l.type === "appli" ? l.appli.favicon : l.type === "historique" ? faviconVisite(l.url) : null;
  const etiquette = (l: LigneCommande): string =>
    l.type === "action" ? "Action" : l.type === "onglet" ? "Onglet" : l.type === "appli" ? "Appli" : l.type === "historique" ? "Historique" : "";
  const detail = (l: LigneCommande): string =>
    l.type === "onglet"
      ? l.onglet.url
      : l.type === "historique"
        ? l.url
        : l.type === "action"
          ? l.saisie !== null
            ? `« ${l.saisie} »`
            : (l.parametre ?? "")
          : "";
  const pictogramme = (l: LigneCommande): NomIcone =>
    l.type === "defaut"
      ? l.texte === ""
        ? "accueil"
        : /^\S+\.\S+$/.test(l.texte)
          ? "globe"
          : "chercher"
      : l.type === "action"
        ? "actions"
        : l.type === "onglet"
          ? "onglet"
          : l.type === "appli"
            ? "applications"
            : "horloge";
</script>

<!-- En capture : la barre passe avant tout le reste (modale, historique…), et Échap ne ferme qu'elle. -->
<svelte:window
  onblur={() => fermerCommande()}
  onkeydowncapture={(e) => {
    if (e.key !== "Escape" || cede) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    // Dans la saisie d'une action, Échap revient d'abord à la liste.
    // Une touche tenue ne fait que ce premier pas.
    if (parametre) {
      if (!e.repeat) sortirParametre();
    } else if (!e.repeat) fermerCommande(true);
  }}
/>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="fond" onclick={(e) => e.target === e.currentTarget && fermerCommande(true)}>
  <!-- Un clic dans la boîte hors du champ (marge, lignes, refus) ne lui prend pas le focus ; le clic d'une ligne agit quand même. -->
  <div class="boite" data-testid="barre-commande" role="dialog" aria-label="Barre de commande" tabindex="-1" onmousedown={(e) => !(e.target instanceof HTMLInputElement) && e.preventDefault()}>
    {#if parametre}
      <div class="ligne-parametre">
        <span class="pastille" data-testid="pastille-commande"><Icone nom="actions" taille={13} />{parametre.nom}</span>
        <input
          bind:this={champParametre}
          bind:value={valeurParametre}
          oninput={() => (refus = "")}
          onkeydown={toucheParametre}
          data-testid="parametre-commande"
          placeholder={parametre.libelle}
          aria-label={parametre.libelle}
          maxlength={PARAMETRE_MAX}
          spellcheck="false"
          autocomplete="off"
        />
      </div>
      <p class="aide" data-testid="aide-parametre">{parametre.libelle} · Entrée pour lancer · Échap pour revenir</p>
      {#if refus}<p class="refus" data-testid="refus-commande">{refus}</p>{/if}
    {:else}
    <input
      bind:this={champ}
      bind:value={texte}
      oninput={() => (choisir(0), (refus = ""))}
      onkeydown={touche}
      data-testid="saisie-commande"
      placeholder="Rechercher ou saisir une adresse"
      spellcheck="false"
      autocomplete="off"
    />
    {#if refus}<p class="refus" data-testid="refus-commande">{refus}</p>{/if}
    <ul role="listbox">
      {#each lignes as l, i (i)}
        {@const titre = titreAvant(lignes, i)}
        {#if titre}<li role="presentation" class="section" data-testid="section-commande">{titre}</li>{/if}
        <li role="option" aria-selected={i === choisie} data-testid="ligne-commande" data-type={l.type}>
          <button type="button" tabindex="-1" class:choisie={i === choisie} onmousemove={() => choisir(i)} onclick={() => executer(l)}>
            <span class="pictogramme" data-type={l.type}>
              {#if favicon(l)}<IconeSite favicon={favicon(l)} titre={libelle(l)} />{:else}<Icone nom={pictogramme(l)} taille={14} />{/if}
            </span>
            <span class="libelle">{libelle(l)}</span>
            {#if detail(l)}<span class="detail">{detail(l)}</span>{/if}
            {#if etiquette(l)}<span class="etiquette">{etiquette(l)}</span>{/if}
          </button>
        </li>
      {/each}
    </ul>
    {/if}
  </div>
</div>

<style>
  .fond { position: fixed; inset: 0; display: flex; justify-content: center; align-items: flex-start; padding: 14vh 16px 0; -webkit-app-region: no-drag; }
  .boite {
    width: min(640px, 100%);
    max-height: 70vh;
    overflow-y: auto;
    padding: 8px;
    background: var(--fond-actif);
    color: var(--texte);
    border: 1px solid var(--bord);
    border-radius: 12px;
    box-shadow: var(--ombre-modale);
    font-size: 14px;
  }
  input { width: 100%; box-sizing: border-box; padding: 10px 12px; font: inherit; font-size: 16px; color: var(--texte); background: var(--fond); border: 1px solid var(--bord); border-radius: 8px; outline: none; }
  input:focus { border-color: var(--accent); }
  ul { list-style: none; margin: 6px 0 0; padding: 0; }
  button { display: flex; align-items: center; gap: 10px; width: 100%; padding: 7px 10px; border: 0; border-radius: 8px; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; }
  button.choisie { background: var(--fond); }
  .libelle { flex: none; max-width: 70%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .refus { margin: 6px 2px 0; color: var(--en-erreur); font-size: 13px; }
  .section { margin: 10px 10px 4px; font-size: 11px; font-weight: 600; letter-spacing: 0.02em; color: var(--texte-doux); }
  .section:first-child { margin-top: 4px; }
  .pictogramme { display: grid; place-items: center; flex: none; width: 24px; height: 24px; border-radius: 6px; background: var(--fond); color: var(--texte-doux); }
  button.choisie .pictogramme { background: var(--fond-actif); }
  .pictogramme[data-type="action"] { color: var(--accent); }
  .ligne-parametre { display: flex; align-items: center; gap: 8px; padding: 4px 4px 4px 8px; background: var(--fond); border: 1px solid var(--accent); border-radius: 8px; }
  .ligne-parametre input { border: 0; padding: 6px 4px; background: none; }
  .pastille { display: inline-flex; align-items: center; gap: 5px; flex: none; max-width: 45%; padding: 3px 8px; border-radius: 6px; background: var(--fond-actif); color: var(--accent); font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .aide { margin: 8px 4px 2px; font-size: 12px; color: var(--texte-doux); }
  .etiquette { margin-left: auto; flex: none; opacity: 0.5; font-size: 11px; }
  .detail { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: 0.6; font-size: 12px; }
</style>
