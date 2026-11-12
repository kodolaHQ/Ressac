<script lang="ts">
  import { fade } from "svelte/transition";
  import Icon from "./Icon.svelte";
  import type { WindowState } from "../../shared/model";
  import { accessOf, api, appState, closeTab } from "../state.svelte";
  import AccessBadge from "./AccessBadge.svelte";
  import SiteIcon from "./SiteIcon.svelte";
  import { openMenu } from "./menu.svelte";

  let { window: win }: { window: WindowState } = $props();
  const order = $derived(win.order[win.activeSpace] ?? []);
  const active = $derived(win.active[win.activeSpace]);
  /** Drop point: before or after the hovered tab, depending on the half under the mouse (the line shows it). */
  let hover = $state<{ index: number; after: boolean } | null>(null);

  function drop(e: DragEvent, index: number) {
    const after = hover?.index === index && hover.after;
    hover = null;
    const id = e.dataTransfer?.getData("application/x-webaios-onglet");
    if (!id) return;
    // deplacerOnglet counts without the moved tab: coming from above shifts the target by one.
    const position = index + (after ? 1 : 0);
    api.dispatch({ type: "moveTab", id, index: order.indexOf(id) < position ? position - 1 : position });
  }

  /** Rows are 36 px apart: the highlight slides to the active one (hidden when the active page is not a listed tab). */
  const activeIndex = $derived(active ? order.indexOf(active) : -1);
  // Rows mounted together (a space switch, the first render) rise in cascade, 45 ms apart; a lone new tab rises at once.
  let batch = 0;
  function rise(node: HTMLElement) {
    if (batch === 0) requestAnimationFrame(() => (batch = 0));
    node.style.animationDelay = `${batch++ * 45}ms`;
  }
</script>

<ul class="tabs" role="tablist" aria-orientation="vertical">
  <li class="highlight" role="presentation" aria-hidden="true" class:shown={activeIndex >= 0} style:transform="translateY({Math.max(activeIndex, 0) * 36}px)"></li>
  {#each order as id, index (id)}
    {@const tab = appState.value?.tabs[id]}
    {@const agentRights = accessOf(id)}
    {#if tab}
      <li
        data-testid="tab-{id}"
        use:rise
        role="tab"
        tabindex="0"
        aria-selected={id === active}
        aria-current={id === active ? "page" : undefined}
        class:before={hover?.index === index && !hover.after}
        class:after={hover?.index === index && hover.after}
        class:yours={tab.agentSearch?.state === "yours"}
        draggable="true"
        ondragstart={(e) => e.dataTransfer?.setData("application/x-webaios-onglet", id)}
        ondragover={(e) => {
          e.preventDefault();
          const r = e.currentTarget.getBoundingClientRect();
          hover = { index, after: e.clientY > r.top + r.height / 2 };
        }}
        ondragleave={() => (hover = null)}
        ondrop={(e) => drop(e, index)}
        onclick={(e) => e.button === 0 && api.dispatch({ type: "activateTab", id })}
        onkeydown={(e) => (e.key === "Enter" || e.key === " ") && api.dispatch({ type: "activateTab", id })}
        onauxclick={(e) => e.button === 1 && closeTab(id)}
        oncontextmenu={(e) =>
          openMenu(e, [
            { label: "Épingler", dispatch: () => api.dispatch({ type: "pinTab", id }) },
            { label: "Ajouter aux essentiels", dispatch: () => api.dispatch({ type: "addEssential", id }) },
            ...(appState.value?.spaces ?? []).filter((s) => s.id !== win.activeSpace).map((s) => ({ label: `Envoyer vers ${s.icon} ${s.name}`, dispatch: () => api.dispatch({ type: "moveTabToSpace", id, spaceId: s.id }) })),
            { label: "Fermer", dispatch: () => closeTab(id) },
          ])}
      >
        {#if tab.loading}<span class="spinner" aria-label="Chargement"></span>{:else}<SiteIcon favicon={tab.favicon} title={tab.title} />{/if}
        <span class="title">{tab.title}</span>
        {#if agentRights}<AccessBadge {id} state={agentRights} />{/if}
        {#if tab.agentSearch?.state === "yours"}<span class="yours-tag" data-testid="tab-yours" out:fade={{ duration: 150 }}>à vous</span>{/if}
        {#if tab.openedByAgent}<span class="agent" title="Ouvert par l'agent">✦</span>{/if}
        <button
          class="close"
          aria-label="Fermer l'onglet"
          onclick={(e) => {
            e.stopPropagation();
            closeTab(id);
          }}><Icon name="close" size={12} /></button
        >
      </li>
    {/if}
  {/each}
</ul>

<style>
  .tabs { position: relative; list-style: none; margin: 0; padding: 0; }
  li[role="tab"] {
    position: relative;
    display: flex;
    align-items: center;
    gap: 10px;
    height: 34px;
    margin-bottom: 2px;
    padding: 0 6px 0 10px;
    border-radius: 10px;
    color: var(--text);
    cursor: default;
    transition: transform var(--tap), background var(--tap);
    animation: webaios-rise var(--spring-d) var(--spring) backwards;
  }
  li[role="tab"]:hover:not([aria-current="page"]) { background: color-mix(in srgb, var(--glass-hi) 50%, transparent); }
  li[role="tab"]:active { transform: scale(0.97); }
  /* One highlight for the whole list: it slides on the spring from the old active tab to the new one. */
  .highlight {
    position: absolute;
    inset: 0 0 auto;
    height: 34px;
    border-radius: 10px;
    background: var(--glass-hi);
    box-shadow: var(--lift), inset 0 0 0 1px var(--glass-edge);
    opacity: 0;
    pointer-events: none;
    transition: transform var(--spring-d) var(--spring), opacity var(--tap);
  }
  .highlight.shown { opacity: 1; }
  li.before { box-shadow: inset 0 2px 0 var(--accent); }
  li.after { box-shadow: inset 0 -2px 0 var(--accent); }
  .title { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  [aria-current="page"] .title { font-weight: 500; }
  .agent { color: var(--accent); }
  /* The agent hands this tab to the user: an accent outline and a tag, visible while another tab is active. */
  li.yours { box-shadow: inset 0 0 0 1.5px var(--accent); }
  .yours-tag { flex: none; font-size: 11px; color: var(--accent); animation: webaios-rise var(--spring-d) var(--spring) backwards; }
  .close { all: unset; display: grid; place-content: center; width: 20px; height: 20px; border-radius: 6px; opacity: 0; color: var(--text-muted); transition: opacity var(--tap), background var(--tap); }
  .close:hover { background: var(--glass-hi); color: var(--text); }
  li:hover .close { opacity: 1; }
  .spinner { width: 12px; height: 12px; margin: 2px; flex: none; border: 2px solid var(--accent); border-top-color: transparent; border-radius: 50%; animation: tourne 0.8s linear infinite; }
  @keyframes tourne { to { transform: rotate(360deg); } }
</style>
