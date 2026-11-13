<script lang="ts">
  import { fade } from "svelte/transition";
  import type { WindowState } from "../../shared/model";
  import { api, appState } from "../state.svelte";
  import Icon from "./Icon.svelte";
  import SiteIcon from "./SiteIcon.svelte";
  import SoundButton from "./SoundButton.svelte";

  /** What goes on in this window's background tabs: a call (back to it, microphone, camera), a video or music (back to it, play / pause, sound). */
  let { window: win }: { window: WindowState } = $props();
  const calls = $derived(Object.values(appState.value?.tabs ?? {}).filter((t) => t.call && t.windowId === win.id));
  /** Tabs with a media session (a video, music) that are not the one shown; a call has its own bar. */
  const playing = $derived(Object.values(appState.value?.tabs ?? {}).filter((t) => t.playback && !t.call && t.windowId === win.id && win.active[win.activeSpace] !== t.id));
  const press = (id: string, which: "mic" | "camera") => window.parent.ressacWindow?.pressCall(id, which);
</script>

{#each calls as tab (tab.id)}
  <div class="call" data-testid="call-bar" role="group" aria-label="Appel en cours : {tab.title}" out:fade={{ duration: 150 }}>
    <button class="back" data-testid="call-back" title="Revenir à l'appel : {tab.title}" onclick={() => api.dispatch({ type: "activateTab", id: tab.id })}>
      <SiteIcon favicon={tab.favicon} title={tab.title} />
      <span>{tab.title}</span>
    </button>
    <button
      class="toggle"
      class:off={!tab.call!.mic}
      data-testid="call-mic"
      aria-pressed={tab.call!.mic}
      aria-label={tab.call!.mic ? "Couper le micro" : "Activer le micro"}
      title={tab.call!.mic ? "Couper le micro" : "Activer le micro"}
      onclick={() => press(tab.id, "mic")}><Icon name={tab.call!.mic ? "mic" : "mic-off"} size={16} /></button
    >
    <button
      class="toggle"
      class:off={!tab.call!.camera}
      data-testid="call-camera"
      aria-pressed={tab.call!.camera}
      aria-label={tab.call!.camera ? "Couper la caméra" : "Activer la caméra"}
      title={tab.call!.camera ? "Couper la caméra" : "Activer la caméra"}
      onclick={() => press(tab.id, "camera")}><Icon name={tab.call!.camera ? "camera" : "camera-off"} size={16} /></button
    >
  </div>
{/each}
{#each playing as tab (tab.id)}
  <div class="call" data-testid="media-bar" role="group" aria-label="Lecture en cours : {tab.title}" out:fade={{ duration: 150 }}>
    <button class="back" data-testid="media-back" title="Revenir à l'onglet : {tab.title}" onclick={() => api.dispatch({ type: "activateTab", id: tab.id })}>
      <SiteIcon favicon={tab.favicon} title={tab.title} />
      <span>{tab.title}</span>
    </button>
    <button
      class="toggle"
      data-testid="media-play"
      aria-label={tab.playback === "playing" ? "Mettre en pause" : "Reprendre la lecture"}
      title={tab.playback === "playing" ? "Mettre en pause" : "Reprendre la lecture"}
      onclick={() => window.parent.ressacWindow?.togglePlayback(tab.id)}><Icon name={tab.playback === "playing" ? "pause" : "play"} size={16} /></button
    >
    <SoundButton {tab} size={16} />
  </div>
{/each}

<style>
  /* A glass pill above the footer: enter spring, exit fade (DESIGN.md). */
  .call { display: flex; align-items: center; gap: 2px; margin: 6px 0; padding: 4px; border-radius: 12px; background: color-mix(in srgb, var(--glass-hi) 60%, transparent); box-shadow: inset 0 0 0 1px var(--glass-edge); -moz-window-dragging: no-drag; animation: ressac-rise var(--spring-d) var(--spring) backwards; }
  button { all: unset; display: flex; align-items: center; border-radius: 8px; transition: transform var(--tap), background var(--tap), color var(--tap); }
  button:hover { background: var(--glass-hi); }
  button:active { transform: scale(0.97); }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .back { flex: 1; min-width: 0; gap: 8px; padding: 4px 6px; font: 500 12.5px var(--font-ui); color: var(--text); }
  .back span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .toggle { flex: none; width: 28px; height: 28px; justify-content: center; color: var(--text); }
  .toggle.off { color: var(--in-error); }
  @media (prefers-reduced-motion: reduce) { .call { animation: none; } }
</style>
