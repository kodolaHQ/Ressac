<script lang="ts">
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
    api.dispatch({ type: "deplacerOnglet", id, index: order.indexOf(id) < position ? position - 1 : position });
  }
</script>

<ul class="onglets" role="tablist" aria-orientation="vertical">
  {#each order as id, index (id)}
    {@const tab = appState.value?.tabs[id]}
    {@const agentRights = accessOf(id)}
    {#if tab}
      <li
        data-testid="onglet-{id}"
        role="tab"
        tabindex="0"
        aria-selected={id === active}
        aria-current={id === active ? "page" : undefined}
        class:avant={hover?.index === index && !hover.after}
        class:apres={hover?.index === index && hover.after}
        draggable="true"
        ondragstart={(e) => e.dataTransfer?.setData("application/x-webaios-onglet", id)}
        ondragover={(e) => {
          e.preventDefault();
          const r = e.currentTarget.getBoundingClientRect();
          hover = { index, after: e.clientY > r.top + r.height / 2 };
        }}
        ondragleave={() => (hover = null)}
        ondrop={(e) => drop(e, index)}
        onclick={() => api.dispatch({ type: "activerOnglet", id })}
        onkeydown={(e) => (e.key === "Enter" || e.key === " ") && api.dispatch({ type: "activerOnglet", id })}
        onauxclick={(e) => e.button === 1 && closeTab(id)}
        oncontextmenu={(e) =>
          openMenu(e, [
            { label: "Épingler", dispatch: () => api.dispatch({ type: "epinglerOnglet", id }) },
            { label: "Ajouter aux essentiels", dispatch: () => api.dispatch({ type: "ajouterEssentiel", id }) },
            { label: "Fermer", dispatch: () => closeTab(id) },
          ])}
      >
        {#if tab.loading}<span class="roue" aria-label="Chargement"></span>{:else}<SiteIcon favicon={tab.favicon} title={tab.title} />{/if}
        <span class="titre">{tab.title}</span>
        {#if agentRights}<AccessBadge {id} state={agentRights} />{/if}
        {#if tab.openedByAgent}<span class="agent" title="Ouvert par l'agent">✦</span>{/if}
        <button
          class="fermer"
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
  .onglets { list-style: none; margin: 0; padding: 0; }
  li { display: flex; align-items: center; gap: 8px; height: 34px; padding: 0 8px; border-radius: 8px; color: var(--texte); cursor: default; }
  li:hover { background: var(--fond-survol); }
  li[aria-current="page"] { background: var(--fond-actif); }
  li.avant { box-shadow: inset 0 2px 0 var(--accent); }
  li.apres { box-shadow: inset 0 -2px 0 var(--accent); }
  .titre { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .agent { color: var(--accent); }
  .fermer { all: unset; opacity: 0; padding: 0 4px; color: var(--texte-doux); }
  li:hover .fermer { opacity: 1; }
  .roue { width: 12px; height: 12px; margin: 2px; flex: none; border: 2px solid var(--texte-doux); border-top-color: transparent; border-radius: 50%; animation: tourne 0.8s linear infinite; }
  @keyframes tourne { to { transform: rotate(360deg); } }
</style>
