<script lang="ts">
  import { api, appState } from "../state.svelte";
  import { t } from "../i18n.svelte";
  import Icon from "./Icon.svelte";
  import type { WindowState } from "../../shared/model";

  // « Cacher pour l'agent »: arms the viewfinder over the tab (a second press leaves); only on a web page.
  let { window: win }: { window: WindowState } = $props();
  const url = $derived.by(() => {
    const id = win.active[win.activeSpace];
    return (id && appState.value?.tabs[id]?.url) || "";
  });
  const web = $derived(/^https?:/.test(url));
  let picking = $state(api.hide.picking());
  $effect(() => api.hide.onChange(() => (picking = api.hide.picking())));
</script>

<button
  data-testid="hide-button"
  aria-label={t("chrome-hide")}
  title={t("chrome-hide")}
  aria-pressed={picking}
  disabled={!web}
  onclick={() => api.hide.toggle()}><Icon name="eye-off" /></button>

<style>
  button { all: unset; height: 24px; padding: 0 6px; display: grid; align-items: center; border-radius: 8px; color: var(--text-muted); cursor: pointer; -webkit-app-region: no-drag; transition: transform var(--tap), background var(--tap); }
  button:active:not(:disabled) { transform: scale(0.97); }
  button:hover:not(:disabled) { background: var(--bg-hover); color: var(--text); }
  button:disabled { opacity: 0.35; cursor: default; }
  button[aria-pressed="true"] { color: var(--accent); }
</style>
