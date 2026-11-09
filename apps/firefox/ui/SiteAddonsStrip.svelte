<script lang="ts">
  import type { ApiSite } from "../shared/api";
  import type { AddonButton } from "../chrome/window/addons";

  // The add-on buttons of the app's window (chrome/window/addons.ts createSiteAddons),
  // copied into this document. Only in the « site » view: on the home or the card a popup would have no page shown.
  // `api` is a prop of the bar, unused: ApiSite.extensions stays inert in Firefox.
  let { onSite: onSite }: { api: ApiSite; onSite: boolean } = $props();
  const addons = window.parent.webaiosSiteWindow!.addons!;
  let buttons = $state<AddonButton[]>(structuredClone(addons.buttons()));

  $effect(() => {
    const off = addons.onChange(() => (buttons = structuredClone(addons.buttons())));
    window.addEventListener("unload", off, { once: true });
    return off;
  });
</script>

{#if onSite}
  {#each buttons as b (b.id)}
    <button
      class="site-addon"
      class:no-icon={!b.icon}
      style:background-image={b.icon ? `url("${b.icon}")` : null}
      data-letter={b.name.charAt(0)}
      data-testid="action-extension-site"
      data-id={b.id}
      title={b.title}
      aria-label={b.title}
      disabled={!b.enabled}
      onclick={(e) => addons.click(b.id, structuredClone(e.currentTarget.getBoundingClientRect().toJSON()))}
    >
      {#if b.badge}<span class="badge" style:background-color={b.badgeColor} style:color={b.badgeTextColor}>{b.badge}</span>{/if}
    </button>
  {/each}
{/if}

<style>
  .site-addon { all: unset; position: relative; width: 24px; height: 24px; flex: none; border-radius: 5px; background-position: center; background-repeat: no-repeat; background-size: 16px; -webkit-app-region: no-drag; }
  .site-addon:hover:not(:disabled) { background-color: var(--fond-survol); }
  .site-addon:disabled { opacity: 0.4; }
  /* Without an icon: the first letter of the name. */
  .site-addon.no-icon::after { content: attr(data-letter); position: absolute; inset: 4px; display: grid; place-content: center; border-radius: 4px; background: var(--fond-actif); color: var(--texte); font-size: 10px; text-transform: uppercase; }
  .badge { position: absolute; right: 0; bottom: 0; padding: 0 2px; border-radius: 2px; font-size: 9px; line-height: 12px; pointer-events: none; }
</style>
