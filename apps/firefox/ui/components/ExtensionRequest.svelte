<script lang="ts">
  import type { PendingRequest } from "../../shared/model";
  import type { ExtensionCard } from "../../shared/extensions";
  import { api } from "../state.svelte";
  import { t } from "../i18n.svelte";

  // Everything from the manifest (name, version, sites, domains) is shown as text, never interpreted.
  let { request, card }: { request: PendingRequest; card: ExtensionCard } = $props();

  // Strengthened grant: « Activer » (and Enter, which clicks the primary button) has no effect until the box is checked.
  let included = $state(false);
  const blocked = $derived(card.hardened && !included);
  const names = (list: string[]) => list.map((n) => t("home-quoted", { name: n })).join(", ");

  /** The name comes from the manifest: bounded, and shown in its own element (it cannot read as the rest of the title). */
  const NAME_MAX = 60;
  const SITES_MAX = 20;
  const name = $derived.by(() => {
    const car = [...card.name];
    return car.length > NAME_MAX ? `${car.slice(0, NAME_MAX - 1).join("")}…` : card.name;
  });
  const sites = $derived(
    card.sites.length > SITES_MAX ? t("home-ext-sites-more", { list: card.sites.slice(0, SITES_MAX).join(", "), count: card.sites.length - SITES_MAX }) : card.sites.join(", "),
  );
</script>

<div data-testid="extension-request">
  {#if card.update}
    <h3>{t("home-ext-update")} <span class="name" data-testid="extension-card-name">{t("home-quoted", { name })}</span>{t("home-ext-update-end")}</h3>
    <div class="subtle">{t("home-ext-version", { from: card.update.from, to: card.version })}</div>
  {:else}
    <h3>{t("home-ext-activate")} <span class="name" data-testid="extension-card-name">{t("home-quoted", { name })}</span> {t("home-ext-activate-in", { space: card.space })}</h3>
  {/if}
  <div class="subtle">{card.source === "store" ? "addons.mozilla.org" : t("home-by-agent")}</div>

  {#if card.rights.length > 0}
    <p class="title">{t("home-ext-wants")}</p>
    <ul>
      {#each card.rights as right, i (i)}<li>{right}</li>{/each}
    </ul>
  {/if}

  {#if card.allSites}
    <p class="alert" data-testid="extension-card-all-sites">{t("home-ext-all-sites")}</p>
  {:else if card.sites.length > 0}
    <p>{t("home-ext-sites", { sites })}</p>
  {/if}

  {#if card.otherSpaces.length > 0}
    <p>{t("home-ext-other-spaces", { names: names(card.otherSpaces) })}</p>
  {/if}

  {#if card.alsoReplaces.length > 0}
    <p class="alert" data-testid="extension-card-replaces">{t("home-ext-also-replaces", { names: names(card.alsoReplaces) })}</p>
  {/if}

  {#if card.source === "agent"}
    {#if card.network}
      <p>
        {card.network.length === 0 ? t("home-ext-network-none") : t("home-ext-network", { sites: card.network.join(", ") })}
      </p>
    {/if}
    <p class="subtle">{t("home-ext-scripts")}</p>
    <p class="subtle">{t("home-ext-agent-blind")}</p>
  {/if}

  {#if card.hardened}
    <div class="strengthened">
      <p id="extension-card-warning">{t("home-ext-hardened")}</p>
      <label>
        <input type="checkbox" data-testid="extension-card-confirm" aria-describedby="extension-card-warning" bind:checked={included} />
        {t("home-ext-confirm")}
      </label>
    </div>
  {/if}

  <!-- Enter refuses (Refuser is the primary button): enabling an extension takes a real click. -->
  <div class="actions">
    <button data-main onclick={() => api.permissions.answer(request.id, "deny")}>{t("home-deny")}</button>
    <button
      class="allow"
      disabled={blocked}
      aria-describedby={blocked ? "extension-card-reason" : undefined}
      onclick={() => api.permissions.answer(request.id, "allow", undefined, { confirmed: included })}>{t("home-ext-enable")}</button
    >
    {#if blocked}<span id="extension-card-reason" class="sr-only">{t("home-ext-tick-first")}</span>{/if}
  </div>
</div>

<style>
  h3 { margin: 0 0 4px; font: 600 17px/1.2 var(--font-display); letter-spacing: -0.01em; overflow-wrap: anywhere; }
  p { margin: 0 0 8px; overflow-wrap: anywhere; }
  .subtle { color: var(--text-muted); font-size: 12px; margin-bottom: 8px; overflow-wrap: anywhere; }
  .title { margin-top: 8px; font-weight: 600; }
  ul { margin: 0 0 10px; padding-left: 18px; }
  li { overflow-wrap: anywhere; }
  .name { display: inline-block; max-width: 100%; padding: 0 6px; border-radius: 6px; background: var(--glass-hi); border: 1px solid var(--border); font-weight: 600; }
  .alert { color: var(--access-act); font-weight: 600; }
  .strengthened { border: 1px solid var(--in-error); background: color-mix(in srgb, var(--in-error) 14%, transparent); border-radius: 10px; padding: 8px 10px; margin: 4px 0 10px; }
  .strengthened p { color: var(--in-error); font-weight: 600; }
  .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  .strengthened label { display: flex; gap: 8px; align-items: flex-start; font-weight: 600; }
  .strengthened input { margin-top: 3px; }
  .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
  button { padding: 7px 14px; border-radius: 10px; border: 1px solid var(--border); background: var(--glass-hi); color: var(--text); font: 600 12.5px var(--font-ui); cursor: pointer; transition: transform var(--tap), background var(--tap); }
  button:hover:not(:disabled) { background: var(--bg-active); }
  button:active:not(:disabled) { transform: scale(0.97); }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  .allow { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
</style>
