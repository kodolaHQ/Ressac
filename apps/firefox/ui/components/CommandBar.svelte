<script lang="ts">
  import { tick, untrack } from "svelte";
  import type { WindowState, Tab } from "../../shared/model";
  import { api, appState } from "../state.svelte";
  import { closeCommand, command, focusEmptyPage } from "./command.svelte";
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
  } from "./command";
  import { walkableTabs } from "../../shared/walkable-tabs";
  import type { ActionShown } from "../../shared/actions";
  import type { Visit } from "../../shared/model";
  import SiteIcon from "./SiteIcon.svelte";
  import Icon, { type IconName } from "./Icon.svelte";

  /**
   * Command bar (⌘T, ⌘L): a box above the frozen, blurred page (FrozenBackground, mounted by App). The field is mounted right
   * away: the keystroke following the shortcut does not wait for the capture.
   */
  let {
    window: win,
    activeTab: activeTab,
    yields: yields,
    closePanel: closePanel,
  }: {
    window: WindowState;
    activeTab: Tab | undefined;
    /** The ⌃Tab panel is open on top: it keeps Escape. */
    yields: boolean;
    /** Closes the interface panel (history…) laid over the page. */
    closePanel: () => void;
  } = $props();

  // Actions are not available in a private space (a missing space counts as private), like on the empty page.
  const inPrivate = $derived(appState.value?.spaces.find((e) => e.id === win.activeSpace)?.private ?? true);
  let actions = $state.raw<ActionShown[]>([]);
  let projects = $state.raw<SiteApp[]>([]);
  let sites = $state.raw<SiteApp[]>([]);
  let hist = $state.raw<Visit[]>([]);

  /** Re-reads a source at startup and on each of its changes; only the last reply counts. */
  function follow<T>(read: () => Promise<T>, ask: (v: T) => void, onChange: (callback: () => void) => () => void): () => void {
    let last = 0;
    const load = () => {
      const n = ++last;
      read().then(
        (v) => n === last && ask(v),
        () => {},
      );
    };
    load();
    return onChange(load);
  }

  $effect(() => {
    if (inPrivate) {
      actions = [];
      return;
    }
    return follow(() => api.actions.list(), (l) => (actions = l), (r) => api.actions.onChange(r));
  });
  $effect(() => follow(() => api.apps.list(), (l) => (projects = l.apps.map(projectSiteApp).filter((a) => a !== null)), (r) => api.apps.onChange(r)));
  $effect(() => follow(() => api.sites.list(), (l) => (sites = l.map(siteSiteApp)), (r) => api.sites.onChange(r)));

  // The tabs the active space shows: same scope as ⌃Tab.
  const tabs = $derived.by<SourceTab[]>(() => {
    const e = appState.value;
    if (!e) return [];
    return walkableTabs(e, win.id).flatMap((id) => {
      const o = e.tabs[id];
      return o ? [{ id: o.id, title: o.title, url: o.url, favicon: o.favicon }] : [];
    });
  });

  const sources: CommandSources = $derived({ actions, tabs: tabs, siteApps: [...projects, ...sites], history: hist });

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
    api.history.search(t, LIMITS.history, true).then(
      (v) => n === request && (hist = v),
      () => n === request && (hist = []),
    );
  });

  let rawChosen = $state(0);
  let field: HTMLInputElement | undefined = $state();

  /** A chosen action awaiting its input: the bar asks for it in a second field, the list hides. */
  let param = $state<{ id: string; name: string; label: string } | null>(null);
  let paramValue = $state("");
  let paramField: HTMLInputElement | undefined = $state();

  const mode = $derived(command.open?.mode ?? "nouveau");
  const lignes: CommandLine[] = $derived(commandLines(text, sources, mode === "actif" ? (activeTab?.url ?? null) : null, activeTab?.id ?? null));
  // A late source may shorten the list: the selection stays on a row that exists (the first otherwise).
  const chosen = $derived(rawChosen >= 0 && rawChosen < lignes.length ? rawChosen : 0);
  const choose = (i: number) => (rawChosen = i);

  // An action launched: a second Enter does not relaunch it, and its reply arriving after a close or another
  // opening (each is a new object) is ignored.
  let runningAction = false;
  /** Changes on each launch and each list ↔ input switch: the reply of an abandoned launch is ignored. */
  let launch = 0;

  // On each opening (the first, or a reopening in the other mode): starting input, all selected in « actif » mode.
  $effect(() => {
    const o = command.open;
    if (!o) return;
    runningAction = false;
    param = null;
    text = o.text;
    rawChosen = 0;
    denial = "";
    void tick().then(() => {
      field?.focus();
      if (o.mode === "actif") field?.select();
    });
  });

  /** The only function that acts: a chosen row (Enter or click). */
  function run(l: CommandLine) {
    const target = mode === "actif" ? (activeTab?.id ?? null) : null;
    if (l.type === "defaut" && l.text === "") {
      // Home: no effect if it is already shown; an interface panel laid over it closes.
      api.dispatch({ type: "afficherPageVide", windowId: win.id });
      closePanel();
      closeCommand();
      // Already on home, it is not remounted: its field takes the keyboard back (and takes it when mounting otherwise).
      focusEmptyPage.n++;
      return;
    }
    if (l.type === "action") {
      if (paramRequest(l)) enterParam(l);
      else launchAction(l.id, l.input);
      return;
    }
    if (l.type === "defaut") api.navigate(target, l.text);
    else if (l.type === "historique") api.navigate(target, l.url);
    else if (l.type === "onglet") {
      // Like the sidebar and ⌃Tab: an essential opens through its favorite (its tab may belong to a sibling space).
      const link = appState.value?.tabs[l.tab.id]?.link;
      api.dispatch(link?.type === "essentiel" ? { type: "ouvrirFavori", windowId: win.id, kind: "essentiel", id: link.id } : { type: "activerOnglet", id: l.tab.id });
    } else if (l.app.kind === "projet") api.apps.dispatch(l.app.id, l.app.action);
    else api.sites.dispatch(l.app.id, "ouvrir");
    closeCommand(true);
  }

  /** Opens the action's page and launches it with `saisie` (without a required input and absent: the page asks for it). */
  function launchAction(id: string, input: string | null) {
    if (runningAction) return;
    const o = command.open;
    const n = ++launch;
    runningAction = true;
    denial = "";
    void api.actions.open(id, input).then(
      (r) => {
        if (o !== command.open || n !== launch) return;
        runningAction = false;
        if (r.ok) closeCommand();
        else denial = r.error;
      },
      () => {
        if (o !== command.open || n !== launch) return;
        runningAction = false;
        denial = "Le service des actions ne répond pas";
      },
    );
  }

  /** Switches to the action's input, prefilled with the shown page's address, all selected. */
  function enterParam(l: Extract<CommandLine, { type: "action" }> & { param: string }) {
    launch++;
    runningAction = false;
    param = { id: l.id, name: l.name, label: l.param };
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
    runningAction = false;
    param = null;
    denial = "";
    void tick().then(() => field?.focus());
  }

  function paramKey(e: KeyboardEvent) {
    if (e.isComposing || !param) return;
    if (e.key === "Enter") {
      if (!e.repeat) launchAction(param.id, paramValue.trim() || null);
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
      if (l && !e.repeat) run(l);
    } else if (e.key === "Tab") {
      // Tab on an action awaiting its input: it is given right away, like Enter.
      const l = lignes[chosen];
      if (l && paramRequest(l) && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) enterParam(l);
    } else return;
    e.preventDefault();
    e.stopPropagation();
  }

  const label = (l: CommandLine): string =>
    l.type === "defaut" ? l.label : l.type === "action" ? l.name : l.type === "onglet" ? l.tab.title : l.type === "appli" ? l.app.name : l.title || l.url;
  // History keeps no favicon: the site's, at the usual address (except in a private visit, nothing leaves).
  const visitFavicon = (url: string): string | null =>
    /^https?:\/\//i.test(url) && hist.some((v) => v.url === url && !v.private) ? `${new URL(url).origin}/favicon.ico` : null;
  const favicon = (l: CommandLine): string | null =>
    l.type === "onglet" ? l.tab.favicon : l.type === "appli" ? l.app.favicon : l.type === "historique" ? visitFavicon(l.url) : null;
  const badgeText = (l: CommandLine): string =>
    l.type === "action" ? "Action" : l.type === "onglet" ? "Onglet" : l.type === "appli" ? "Appli" : l.type === "historique" ? "Historique" : "";
  const detail = (l: CommandLine): string =>
    l.type === "onglet"
      ? l.tab.url
      : l.type === "historique"
        ? l.url
        : l.type === "action"
          ? l.input !== null
            ? `« ${l.input} »`
            : (l.param ?? "")
          : "";
  const pictogram = (l: CommandLine): IconName =>
    l.type === "defaut"
      ? l.text === ""
        ? "home"
        : /^\S+\.\S+$/.test(l.text)
          ? "globe"
          : "find"
      : l.type === "action"
        ? "actions"
        : l.type === "onglet"
          ? "tab"
          : l.type === "appli"
            ? "apps"
            : "clock";
</script>

<!-- In capture: the bar goes before everything else (modal, history…), and Escape only closes it. -->
<svelte:window
  onblur={() => closeCommand()}
  onkeydowncapture={(e) => {
    if (e.key !== "Escape" || yields) return;
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
        <span class="pastille" data-testid="pastille-commande"><Icon name="actions" size={13} />{param.name}</span>
        <input
          bind:this={paramField}
          bind:value={paramValue}
          oninput={() => (denial = "")}
          onkeydown={paramKey}
          data-testid="parametre-commande"
          placeholder={param.label}
          aria-label={param.label}
          maxlength={PARAM_MAX}
          spellcheck="false"
          autocomplete="off"
        />
      </div>
      <p class="aide" data-testid="aide-parametre">{param.label} · Entrée pour lancer · Échap pour revenir</p>
      {#if denial}<p class="refus" data-testid="refus-commande">{denial}</p>{/if}
    {:else}
    <input
      bind:this={field}
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
        {@const title = titleBefore(lignes, i)}
        {#if title}<li role="presentation" class="section" data-testid="section-commande">{title}</li>{/if}
        <li role="option" aria-selected={i === chosen} data-testid="ligne-commande" data-type={l.type}>
          <button type="button" tabindex="-1" class:choisie={i === chosen} onmousemove={() => choose(i)} onclick={() => run(l)}>
            <span class="pictogramme" data-type={l.type}>
              {#if favicon(l)}<SiteIcon favicon={favicon(l)} title={label(l)} />{:else}<Icon name={pictogram(l)} size={14} />{/if}
            </span>
            <span class="libelle">{label(l)}</span>
            {#if detail(l)}<span class="detail">{detail(l)}</span>{/if}
            {#if badgeText(l)}<span class="etiquette">{badgeText(l)}</span>{/if}
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
