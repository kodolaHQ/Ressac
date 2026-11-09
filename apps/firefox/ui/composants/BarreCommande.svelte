<script lang="ts">
  import { tick, untrack } from "svelte";
  import type { WindowState, Tab } from "../../shared/modele";
  import { api, appState } from "../etat.svelte";
  import { closeCommand, command, focusEmptyPage } from "./commande.svelte";
  import {
    LIMITS,
    PARAM_MAX,
    projectSiteApp,
    siteSiteApp,
    paramRequest,
    commandLines,
    defaultParam,
    titleBefore,
    type SiteApp,
    type CommandLine,
    type SourceTab,
    type CommandSources,
  } from "./commande";
  import { walkableTabs } from "../../shared/onglets-parcourables";
  import type { ActionShown } from "../../shared/actions";
  import type { Visite } from "../../shared/modele";
  import SiteIcon from "./IconeSite.svelte";
  import Icon, { type IconName } from "./Icone.svelte";

  /**
   * Command bar (⌘T, ⌘L): a box above the frozen, blurred page (FondFige, mounted by App). The field is mounted right
   * away: the keystroke following the shortcut does not wait for the capture.
   */
  let {
    fenetre: win,
    ongletActif: activeTab,
    cede,
    fermerPanneau: closePanel,
  }: {
    fenetre: WindowState;
    ongletActif: Tab | undefined;
    /** The ⌃Tab panel is open on top: it keeps Escape. */
    cede: boolean;
    /** Closes the interface panel (history…) laid over the page. */
    fermerPanneau: () => void;
  } = $props();

  // Actions are not available in a private space (a missing space counts as private), like on the empty page.
  const inPrivate = $derived(appState.valeur?.espaces.find((e) => e.id === win.espaceActif)?.prive ?? true);
  let actions = $state.raw<ActionShown[]>([]);
  let projects = $state.raw<SiteApp[]>([]);
  let sites = $state.raw<SiteApp[]>([]);
  let hist = $state.raw<Visite[]>([]);

  /** Re-reads a source at startup and on each of its changes; only the last reply counts. */
  function follow<T>(lire: () => Promise<T>, poser: (v: T) => void, surChange: (rappel: () => void) => () => void): () => void {
    let last = 0;
    const charger = () => {
      const n = ++last;
      lire().then(
        (v) => n === last && poser(v),
        () => {},
      );
    };
    charger();
    return surChange(charger);
  }

  $effect(() => {
    if (inPrivate) {
      actions = [];
      return;
    }
    return follow(() => api.actions.liste(), (l) => (actions = l), (r) => api.actions.surChange(r));
  });
  $effect(() => follow(() => api.applications.liste(), (l) => (projects = l.applications.map(projectSiteApp).filter((a) => a !== null)), (r) => api.applications.surChange(r)));
  $effect(() => follow(() => api.sites.liste(), (l) => (sites = l.map(siteSiteApp)), (r) => api.sites.surChange(r)));

  // The tabs the active space shows: same scope as ⌃Tab.
  const tabs = $derived.by<SourceTab[]>(() => {
    const e = appState.valeur;
    if (!e) return [];
    return walkableTabs(e, win.id).flatMap((id) => {
      const o = e.onglets[id];
      return o ? [{ id: o.id, titre: o.titre, url: o.url, favicon: o.favicon }] : [];
    });
  });

  const sources: CommandSources = $derived({ actions, onglets: tabs, applis: [...projects, ...sites], historique: hist });

  let text = $state("");
  let denial = $state("");
  let request = 0;

  // History is requested again on each keystroke; a reply that arrives after a more recent keystroke is ignored.
  $effect(() => {
    const t = text.trim();
    const n = ++request;
    if (!t) {
      hist = [];
      return;
    }
    api.historique.rechercher(t, LIMITS.historique, true).then(
      (v) => n === request && (hist = v),
      () => n === request && (hist = []),
    );
  });

  let rawChosen = $state(0);
  let champ: HTMLInputElement | undefined = $state();

  /** A chosen action awaiting its input: the bar asks for it in a second field, the list hides. */
  let param = $state<{ id: string; nom: string; libelle: string } | null>(null);
  let paramValue = $state("");
  let paramField: HTMLInputElement | undefined = $state();

  const mode = $derived(command.ouverte?.mode ?? "nouveau");
  const lignes: CommandLine[] = $derived(commandLines(text, sources, mode === "actif" ? (activeTab?.url ?? null) : null, activeTab?.id ?? null));
  // A late source may shorten the list: the selection stays on a row that exists (the first otherwise).
  const chosen = $derived(rawChosen >= 0 && rawChosen < lignes.length ? rawChosen : 0);
  const choose = (i: number) => (rawChosen = i);

  // An action launched: a second Enter does not relaunch it, and its reply arriving after a close or another
  // opening (each is a new object) is ignored.
  let actionEnCours = false;
  /** Changes on each launch and each list ↔ input switch: the reply of an abandoned launch is ignored. */
  let launch = 0;

  // On each opening (the first, or a reopening in the other mode): starting input, all selected in « actif » mode.
  $effect(() => {
    const o = command.ouverte;
    if (!o) return;
    actionEnCours = false;
    param = null;
    text = o.texte;
    rawChosen = 0;
    denial = "";
    void tick().then(() => {
      champ?.focus();
      if (o.mode === "actif") champ?.select();
    });
  });

  /** The only function that acts: a chosen row (Enter or click). */
  function executer(l: CommandLine) {
    const target = mode === "actif" ? (activeTab?.id ?? null) : null;
    if (l.type === "defaut" && l.texte === "") {
      // Home: no effect if it is already shown; an interface panel laid over it closes.
      api.agir({ type: "afficherPageVide", fenetreId: win.id });
      closePanel();
      closeCommand();
      // Already on home, it is not remounted: its field takes the keyboard back (and takes it when mounting otherwise).
      focusEmptyPage.n++;
      return;
    }
    if (l.type === "action") {
      if (paramRequest(l)) enterParam(l);
      else lancerAction(l.id, l.saisie);
      return;
    }
    if (l.type === "defaut") api.naviguer(target, l.texte);
    else if (l.type === "historique") api.naviguer(target, l.url);
    else if (l.type === "onglet") {
      // Like the sidebar and ⌃Tab: an essential opens through its favorite (its tab may belong to a sibling space).
      const lien = appState.valeur?.onglets[l.onglet.id]?.lien;
      api.agir(lien?.type === "essentiel" ? { type: "ouvrirFavori", fenetreId: win.id, genre: "essentiel", id: lien.id } : { type: "activerOnglet", id: l.onglet.id });
    } else if (l.appli.genre === "projet") api.applications.agir(l.appli.id, l.appli.action);
    else api.sites.agir(l.appli.id, "ouvrir");
    closeCommand(true);
  }

  /** Opens the action's page and launches it with `saisie` (without a required input and absent: the page asks for it). */
  function lancerAction(id: string, input: string | null) {
    if (actionEnCours) return;
    const o = command.ouverte;
    const n = ++launch;
    actionEnCours = true;
    denial = "";
    void api.actions.ouvrir(id, input).then(
      (r) => {
        if (o !== command.ouverte || n !== launch) return;
        actionEnCours = false;
        if (r.ok) closeCommand();
        else denial = r.erreur;
      },
      () => {
        if (o !== command.ouverte || n !== launch) return;
        actionEnCours = false;
        denial = "Le service des actions ne répond pas";
      },
    );
  }

  /** Switches to the action's input, prefilled with the shown page's address, all selected. */
  function enterParam(l: Extract<CommandLine, { type: "action" }> & { parametre: string }) {
    launch++;
    actionEnCours = false;
    param = { id: l.id, nom: l.nom, libelle: l.parametre };
    paramValue = paramDefault;
    denial = "";
    void tick().then(() => {
      paramField?.focus();
      paramField?.select();
    });
  }

  // The shown page navigates during input: the proposed address follows, as long as the user has not edited it.
  const paramDefault = $derived(defaultParam(activeTab?.url));
  let prefilled = "";
  $effect(() => {
    const d = paramDefault;
    untrack(() => {
      if (param && paramValue === prefilled && d !== prefilled) {
        paramValue = d;
        void tick().then(() => paramField?.select());
      }
      prefilled = d;
    });
  });

  /** Goes back to the list, the typed text intact. */
  function exitParam() {
    launch++;
    actionEnCours = false;
    param = null;
    denial = "";
    void tick().then(() => champ?.focus());
  }

  function paramKey(e: KeyboardEvent) {
    if (e.isComposing || !param) return;
    if (e.key === "Enter") {
      if (!e.repeat) lancerAction(param.id, paramValue.trim() || null);
    } else if (e.key === "Backspace" && paramValue === "") {
      // A held key clears the field without going back to the list (nor clearing the typed text afterwards).
      if (!e.repeat) exitParam();
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
  function key(e: KeyboardEvent) {
    if (e.isComposing) return;
    if (e.key === "ArrowDown") choose((chosen + 1) % Math.max(lignes.length, 1));
    else if (e.key === "ArrowUp") choose((chosen - 1 + lignes.length) % Math.max(lignes.length, 1));
    else if (e.key === "Enter") {
      const l = lignes[chosen];
      if (l && !e.repeat) executer(l);
    } else if (e.key === "Tab") {
      // Tab on an action awaiting its input: it is given right away, like Enter.
      const l = lignes[chosen];
      if (l && paramRequest(l) && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) enterParam(l);
    } else return;
    e.preventDefault();
    e.stopPropagation();
  }

  const label = (l: CommandLine): string =>
    l.type === "defaut" ? l.libelle : l.type === "action" ? l.nom : l.type === "onglet" ? l.onglet.titre : l.type === "appli" ? l.appli.nom : l.titre || l.url;
  // History keeps no favicon: the site's, at the usual address (except in a private visit, nothing leaves).
  const faviconVisite = (url: string): string | null =>
    /^https?:\/\//i.test(url) && hist.some((v) => v.url === url && !v.prive) ? `${new URL(url).origin}/favicon.ico` : null;
  const favicon = (l: CommandLine): string | null =>
    l.type === "onglet" ? l.onglet.favicon : l.type === "appli" ? l.appli.favicon : l.type === "historique" ? faviconVisite(l.url) : null;
  const etiquette = (l: CommandLine): string =>
    l.type === "action" ? "Action" : l.type === "onglet" ? "Onglet" : l.type === "appli" ? "Appli" : l.type === "historique" ? "Historique" : "";
  const detail = (l: CommandLine): string =>
    l.type === "onglet"
      ? l.onglet.url
      : l.type === "historique"
        ? l.url
        : l.type === "action"
          ? l.saisie !== null
            ? `« ${l.saisie} »`
            : (l.parametre ?? "")
          : "";
  const pictogram = (l: CommandLine): IconName =>
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
  onblur={() => closeCommand()}
  onkeydowncapture={(e) => {
    if (e.key !== "Escape" || cede) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    // In an action's input, Escape first goes back to the list.
    // A held key only does that first step.
    if (param) {
      if (!e.repeat) exitParam();
    } else if (!e.repeat) closeCommand(true);
  }}
/>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="fond" onclick={(e) => e.target === e.currentTarget && closeCommand(true)}>
  <!-- A click in the box outside the field (margin, rows, refusal) does not take its focus; a row's click still acts. -->
  <div class="boite" data-testid="barre-commande" role="dialog" aria-label="Barre de commande" tabindex="-1" onmousedown={(e) => !(e.target instanceof HTMLInputElement) && e.preventDefault()}>
    {#if param}
      <div class="ligne-parametre">
        <span class="pastille" data-testid="pastille-commande"><Icon nom="actions" taille={13} />{param.nom}</span>
        <input
          bind:this={paramField}
          bind:value={paramValue}
          oninput={() => (denial = "")}
          onkeydown={paramKey}
          data-testid="parametre-commande"
          placeholder={param.libelle}
          aria-label={param.libelle}
          maxlength={PARAM_MAX}
          spellcheck="false"
          autocomplete="off"
        />
      </div>
      <p class="aide" data-testid="aide-parametre">{param.libelle} · Entrée pour lancer · Échap pour revenir</p>
      {#if denial}<p class="refus" data-testid="refus-commande">{denial}</p>{/if}
    {:else}
    <input
      bind:this={champ}
      bind:value={text}
      oninput={() => (choose(0), (denial = ""))}
      onkeydown={key}
      data-testid="saisie-commande"
      placeholder="Rechercher ou saisir une adresse"
      spellcheck="false"
      autocomplete="off"
    />
    {#if denial}<p class="refus" data-testid="refus-commande">{denial}</p>{/if}
    <ul role="listbox">
      {#each lignes as l, i (i)}
        {@const titre = titleBefore(lignes, i)}
        {#if titre}<li role="presentation" class="section" data-testid="section-commande">{titre}</li>{/if}
        <li role="option" aria-selected={i === chosen} data-testid="ligne-commande" data-type={l.type}>
          <button type="button" tabindex="-1" class:choisie={i === chosen} onmousemove={() => choose(i)} onclick={() => executer(l)}>
            <span class="pictogramme" data-type={l.type}>
              {#if favicon(l)}<SiteIcon favicon={favicon(l)} titre={label(l)} />{:else}<Icon nom={pictogram(l)} taille={14} />{/if}
            </span>
            <span class="libelle">{label(l)}</span>
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
