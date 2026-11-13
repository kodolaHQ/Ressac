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
  let marks = $state.raw<{ url: string; title: string }[]>([]);

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

  const sources: CommandSources = $derived({ actions, tabs: tabs, siteApps: [...projects, ...sites], history: hist, bookmarks: marks });

  let text = $state("");
  let denial = $state("");
  let request = 0;

  // History is requested again on each keystroke; a reply that arrives after a more recent keystroke is ignored.
  $effect(() => {
    const t = text.trim();
    const n = ++request;
    if (!t) {
      hist = [];
      marks = [];
      return;
    }
    api.bookmarks.search(t, LIMITS.bookmarks * 2).then(
      (v) => n === request && (marks = v),
      () => n === request && (marks = []),
    );
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

  const mode = $derived(command.open?.mode ?? "new");
  const lines: CommandLine[] = $derived(commandLines(text, sources, mode === "active" ? (activeTab?.url ?? null) : null, activeTab?.id ?? null));
  // A late source may shorten the list: the selection stays on a row that exists (the first otherwise).
  const chosen = $derived(rawChosen >= 0 && rawChosen < lines.length ? rawChosen : 0);
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
      if (o.mode === "active") field?.select();
    });
  });

  /** The only function that acts: a chosen row (Enter or click). */
  function run(l: CommandLine) {
    const target = mode === "active" ? (activeTab?.id ?? null) : null;
    if (l.type === "default" && l.text === "") {
      // Home: no effect if it is already shown; an interface panel laid over it closes.
      api.dispatch({ type: "showBlankPage", windowId: win.id });
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
    if (l.type === "default") api.navigate(target, l.text);
    else if (l.type === "history" || l.type === "bookmark") api.navigate(target, l.url);
    else if (l.type === "tab") {
      // Like the sidebar and ⌃Tab: an essential opens through its favorite (its tab may belong to a sibling space).
      const link = appState.value?.tabs[l.tab.id]?.link;
      api.dispatch(link?.type === "essential" ? { type: "openFavorite", windowId: win.id, kind: "essential", id: link.id } : { type: "activateTab", id: l.tab.id });
    } else if (l.app.kind === "project") api.apps.act(l.app.id, l.app.action);
    else api.sites.act(l.app.id, "open");
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
    if (e.key === "ArrowDown") choose((chosen + 1) % Math.max(lines.length, 1));
    else if (e.key === "ArrowUp") choose((chosen - 1 + lines.length) % Math.max(lines.length, 1));
    else if (e.key === "Enter") {
      const l = lines[chosen];
      if (l && !e.repeat) run(l);
    } else if (e.key === "Tab") {
      // Tab on an action awaiting its input: it is given right away, like Enter.
      const l = lines[chosen];
      if (l && paramRequest(l) && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) enterParam(l);
    } else return;
    e.preventDefault();
    e.stopPropagation();
  }

  const label = (l: CommandLine): string =>
    l.type === "default" ? l.label : l.type === "action" ? l.name : l.type === "tab" ? l.tab.title : l.type === "app" ? l.app.name : l.title || l.url;
  // History keeps no favicon: the site's, at the usual address (except in a private visit, nothing leaves).
  const visitFavicon = (url: string): string | null =>
    /^https?:\/\//i.test(url) && hist.some((v) => v.url === url && !v.private) ? `${new URL(url).origin}/favicon.ico` : null;
  const favicon = (l: CommandLine): string | null =>
    l.type === "tab" ? l.tab.favicon : l.type === "app" ? l.app.favicon : l.type === "history" ? visitFavicon(l.url) : null;
  const badgeText = (l: CommandLine): string =>
    l.type === "action" ? "Action" : l.type === "tab" ? "Onglet" : l.type === "app" ? "Appli" : l.type === "history" ? "Historique" : l.type === "bookmark" ? "Favori" : "";
  const detail = (l: CommandLine): string =>
    l.type === "tab"
      ? l.tab.url
      : l.type === "history" || l.type === "bookmark"
        ? l.url
        : l.type === "action"
          ? l.input !== null
            ? `« ${l.input} »`
            : (l.param ?? "")
          : "";
  const pictogram = (l: CommandLine): IconName =>
    l.type === "default"
      ? l.text === ""
        ? "home"
        : /^\S+\.\S+$/.test(l.text)
          ? "globe"
          : "find"
      : l.type === "action"
        ? "actions"
        : l.type === "tab"
          ? "tab"
          : l.type === "app"
            ? "apps"
            : l.type === "bookmark"
              ? "bookmark"
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
<div class="background" onclick={(e) => e.target === e.currentTarget && closeCommand(true)}>
  <!-- A click in the box outside the field (margin, rows, refusal) does not take its focus; a row's click still acts. -->
  <div class="box" data-testid="command-bar" role="dialog" aria-label="Barre de commande" tabindex="-1" onmousedown={(e) => !(e.target instanceof HTMLInputElement) && e.preventDefault()}>
    {#if param}
      <div class="param-line">
        <span class="pill" data-testid="command-pill"><Icon name="actions" size={13} />{param.name}</span>
        <input
          bind:this={paramField}
          bind:value={paramValue}
          oninput={() => (denial = "")}
          onkeydown={paramKey}
          data-testid="command-param"
          placeholder={param.label}
          aria-label={param.label}
          maxlength={PARAM_MAX}
          spellcheck="false"
          autocomplete="off"
        />
      </div>
      <p class="help" data-testid="param-help">{param.label} · Entrée pour lancer · Échap pour revenir</p>
      {#if denial}<p class="refusal" data-testid="command-refusal">{denial}</p>{/if}
    {:else}
    <input
      bind:this={field}
      bind:value={text}
      oninput={() => (choose(0), (denial = ""))}
      onkeydown={key}
      data-testid="command-input"
      placeholder="Rechercher ou saisir une adresse"
      spellcheck="false"
      autocomplete="off"
    />
    {#if denial}<p class="refusal" data-testid="command-refusal">{denial}</p>{/if}
    <ul role="listbox">
      {#each lines as l, i (i)}
        {@const title = titleBefore(lines, i)}
        {#if title}<li role="presentation" class="section" data-testid="command-section">{title}</li>{/if}
        <li role="option" aria-selected={i === chosen} data-testid="command-row" data-type={l.type}>
          <button type="button" tabindex="-1" class:chosen-one={i === chosen} onmousemove={() => choose(i)} onclick={() => run(l)}>
            <span class="pictogram" data-type={l.type}>
              {#if favicon(l)}<SiteIcon favicon={favicon(l)} title={label(l)} />{:else}<Icon name={pictogram(l)} size={14} />{/if}
            </span>
            <span class="label">{label(l)}</span>
            {#if detail(l)}<span class="detail">{detail(l)}</span>{/if}
            {#if badgeText(l)}<span class="tag">{badgeText(l)}</span>{/if}
          </button>
        </li>
      {/each}
    </ul>
    {/if}
  </div>
</div>

<style>
  .background { position: fixed; inset: 0; display: flex; justify-content: center; align-items: flex-start; padding: 14vh 16px 0; -webkit-app-region: no-drag; }
  /* Frosted glass: the blur reaches this document only (sidebar, a frozen page capture); over the live page the dense glass keeps it readable. */
  .box {
    width: min(640px, 100%);
    max-height: 70vh;
    overflow-y: auto;
    background: var(--glass-dense);
    color: var(--text);
    border: 1px solid var(--glass-edge);
    border-radius: 16px;
    box-shadow: var(--modal-shadow);
    backdrop-filter: blur(30px) saturate(1.8);
    font-size: 14px;
    animation: ressac-drop var(--spring-d) var(--spring) backwards;
  }
  input { width: 100%; box-sizing: border-box; padding: 16px 18px; font: 400 17px var(--font-ui); color: var(--text); background: transparent; border: 0; border-bottom: 1px solid var(--border); outline: none; }
  input::placeholder { color: var(--text-muted); }
  ul { list-style: none; margin: 0; padding: 6px; }
  ul:empty { display: none; }
  button { display: flex; align-items: center; gap: 10px; width: 100%; padding: 8px 12px; border: 0; border-radius: 10px; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; transition: transform var(--tap), background var(--tap); }
  button:active { transform: scale(0.97); }
  button.chosen-one { background: var(--glass-hi); box-shadow: inset 0 0 0 1px var(--glass-edge); }
  /* Enter acts on the chosen row (a pseudo-element: the row's text stays its own). */
  button.chosen-one::after { content: "↵"; flex: none; font: 500 11px/1 var(--font-mono); padding: 3px 5px; border-radius: 6px; background: var(--glass-hi); border: 1px solid var(--border); color: var(--text-muted); }
  .label { flex: none; max-width: 70%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .refusal { margin: 8px 18px; color: var(--in-error); font-size: 13px; }
  .section { margin: 10px 12px 4px; font: 600 12px/1.2 var(--font-display); letter-spacing: 0.01em; color: var(--text-muted); }
  .section:first-child { margin-top: 4px; }
  .pictogram { display: grid; place-items: center; flex: none; width: 26px; height: 26px; border-radius: 8px; background: var(--glass-hi); color: var(--text-muted); }
  .pictogram[data-type="action"] { color: var(--accent); }
  .param-line { display: flex; align-items: center; gap: 8px; padding: 8px 10px 8px 14px; border-bottom: 1px solid var(--border); }
  .param-line input { border: 0; padding: 8px 4px; }
  .pill { display: inline-flex; align-items: center; gap: 5px; flex: none; max-width: 45%; padding: 4px 10px; border-radius: 999px; background: var(--accent); color: var(--accent-ink); font-size: 13px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; animation: ressac-drop var(--spring-d) var(--spring) backwards; }
  .help { margin: 10px 18px 12px; font-size: 12px; color: var(--text-muted); }
  .tag { margin-left: auto; flex: none; color: var(--text-muted); font: 11px var(--font-mono); }
  .detail { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-muted); font: 12px var(--font-mono); }
</style>
