<script lang="ts">
  import { tick, untrack } from "svelte";
  import type { EtatFenetre, Onglet } from "../../shared/modele";
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
  import { ongletsParcourables } from "../../shared/onglets-parcourables";
  import type { ActionAffichee } from "../../shared/actions";
  import type { Visite } from "../../shared/modele";
  import IconeSite from "./IconeSite.svelte";
  import Icone, { type NomIcone } from "./Icone.svelte";

  /**
   * Command bar (⌘T, ⌘L): a box above the frozen, blurred page (FondFige, mounted by App). The field is mounted right
   * away: the keystroke following the shortcut does not wait for the capture.
   */
  let {
    fenetre,
    ongletActif,
    cede,
    fermerPanneau,
  }: {
    fenetre: EtatFenetre;
    ongletActif: Onglet | undefined;
    /** The ⌃Tab panel is open on top: it keeps Escape. */
    cede: boolean;
    /** Closes the interface panel (history…) laid over the page. */
    fermerPanneau: () => void;
  } = $props();

  // Actions are not available in a private space (a missing space counts as private), like on the empty page.
  const enPrive = $derived(etat.valeur?.espaces.find((e) => e.id === fenetre.espaceActif)?.prive ?? true);
  let actions = $state.raw<ActionAffichee[]>([]);
  let projets = $state.raw<AppliSource[]>([]);
  let sites = $state.raw<AppliSource[]>([]);
  let historique = $state.raw<Visite[]>([]);

  /** Re-reads a source at startup and on each of its changes; only the last reply counts. */
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

  // The tabs the active space shows: same scope as ⌃Tab.
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

  // History is requested again on each keystroke; a reply that arrives after a more recent keystroke is ignored.
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

  /** A chosen action awaiting its input: the bar asks for it in a second field, the list hides. */
  let parametre = $state<{ id: string; nom: string; libelle: string } | null>(null);
  let valeurParametre = $state("");
  let champParametre: HTMLInputElement | undefined = $state();

  const mode = $derived(commande.ouverte?.mode ?? "nouveau");
  const lignes: LigneCommande[] = $derived(lignesCommande(texte, sources, mode === "actif" ? (ongletActif?.url ?? null) : null, ongletActif?.id ?? null));
  // A late source may shorten the list: the selection stays on a row that exists (the first otherwise).
  const choisie = $derived(choisieBrute >= 0 && choisieBrute < lignes.length ? choisieBrute : 0);
  const choisir = (i: number) => (choisieBrute = i);

  // An action launched: a second Enter does not relaunch it, and its reply arriving after a close or another
  // opening (each is a new object) is ignored.
  let actionEnCours = false;
  /** Changes on each launch and each list ↔ input switch: the reply of an abandoned launch is ignored. */
  let lancement = 0;

  // On each opening (the first, or a reopening in the other mode): starting input, all selected in « actif » mode.
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

  /** The only function that acts: a chosen row (Enter or click). */
  function executer(l: LigneCommande) {
    const cible = mode === "actif" ? (ongletActif?.id ?? null) : null;
    if (l.type === "defaut" && l.texte === "") {
      // Home: no effect if it is already shown; an interface panel laid over it closes.
      api.agir({ type: "afficherPageVide", fenetreId: fenetre.id });
      fermerPanneau();
      fermerCommande();
      // Already on home, it is not remounted: its field takes the keyboard back (and takes it when mounting otherwise).
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
      // Like the sidebar and ⌃Tab: an essential opens through its favorite (its tab may belong to a sibling space).
      const lien = etat.valeur?.onglets[l.onglet.id]?.lien;
      api.agir(lien?.type === "essentiel" ? { type: "ouvrirFavori", fenetreId: fenetre.id, genre: "essentiel", id: lien.id } : { type: "activerOnglet", id: l.onglet.id });
    } else if (l.appli.genre === "projet") api.applications.agir(l.appli.id, l.appli.action);
    else api.sites.agir(l.appli.id, "ouvrir");
    fermerCommande(true);
  }

  /** Opens the action's page and launches it with `saisie` (without a required input and absent: the page asks for it). */
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

  /** Switches to the action's input, prefilled with the shown page's address, all selected. */
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

  // The shown page navigates during input: the proposed address follows, as long as the user has not edited it.
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

  /** Goes back to the list, the typed text intact. */
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
      // A held key clears the field without going back to the list (nor clearing the typed text afterwards).
      if (!e.repeat) sortirParametre();
    }
    else if (e.key !== "Tab") return;
    e.preventDefault();
    e.stopPropagation();
  }

  /**
   * The keys the bar handles stop here: the modals hidden below (agent request, space settings) listen to the window
   * and would otherwise act on what cannot be seen. Tab and ⇧Tab do nothing: the keyboard stays in the field, nothing
   * behind the veil can take it.
   */
  function touche(e: KeyboardEvent) {
    if (e.isComposing) return;
    if (e.key === "ArrowDown") choisir((choisie + 1) % Math.max(lignes.length, 1));
    else if (e.key === "ArrowUp") choisir((choisie - 1 + lignes.length) % Math.max(lignes.length, 1));
    else if (e.key === "Enter") {
      const l = lignes[choisie];
      if (l && !e.repeat) executer(l);
    } else if (e.key === "Tab") {
      // Tab on an action awaiting its input: it is given right away, like Enter.
      const l = lignes[choisie];
      if (l && demandeParametre(l) && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) entrerParametre(l);
    } else return;
    e.preventDefault();
    e.stopPropagation();
  }

  const libelle = (l: LigneCommande): string =>
    l.type === "defaut" ? l.libelle : l.type === "action" ? l.nom : l.type === "onglet" ? l.onglet.titre : l.type === "appli" ? l.appli.nom : l.titre || l.url;
  // History keeps no favicon: the site's, at the usual address (except in a private visit, nothing leaves).
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

<!-- In capture: the bar goes before everything else (modal, history…), and Escape only closes it. -->
<svelte:window
  onblur={() => fermerCommande()}
  onkeydowncapture={(e) => {
    if (e.key !== "Escape" || cede) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    // In an action's input, Escape first goes back to the list.
    // A held key only does that first step.
    if (parametre) {
      if (!e.repeat) sortirParametre();
    } else if (!e.repeat) fermerCommande(true);
  }}
/>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="fond" onclick={(e) => e.target === e.currentTarget && fermerCommande(true)}>
  <!-- A click in the box outside the field (margin, rows, refusal) does not take its focus; a row's click still acts. -->
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
