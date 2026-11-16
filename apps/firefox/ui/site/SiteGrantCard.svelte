<script lang="ts">
  import { ts } from "./locale.svelte";
  import type { SiteGrantRequest } from "../../shared/sites";

  /**
   * The grant card for the app's tweaks, in its window: what the agent asks for (domains, sign-in, frames,
   * resume) and what it injects. Everything comes from site.json, written by the agent: shown as text, never as HTML.
   */
  let { grant, onGrant: giveGrant }: { grant: SiteGrantRequest; onGrant: (yes: boolean, hash: string) => Promise<void> } = $props();
  let running = $state(false);
  // The card can replace the app under the pointer (the agent rewrote site.json): it takes a click only after ARM_MS,
  // re-armed for each new set of rights.
  const ARM_MS = 500;
  let armed = $state(false);
  const rights = $derived(grant.hash);
  $effect(() => {
    void rights;
    armed = false;
    const t = setTimeout(() => (armed = true), ARM_MS);
    return () => clearTimeout(t);
  });

  const choose = (yes: boolean) => {
    if (running || !armed) return;
    running = true;
    // The hash of the rights shown: the main process only grants those.
    void giveGrant(yes, grant.hash).finally(() => (running = false));
  };
</script>

<section class="zone" data-testid="site-grant-zone">
  <div class="card" role="dialog" aria-labelledby="site-grant-title" data-testid="site-grant-card" data-armed={armed || undefined}>
    <h2 id="site-grant-title">{ts("chrome-grant-title", { name: grant.name })}</h2>
    <dl>
      <dt>{ts("chrome-grant-domains")}</dt>
      <dd data-testid="site-grant-domains">{grant.domains.join(", ")}</dd>
      {#if grant.tracked.length}
        <dt>{ts("chrome-grant-tracked")}</dt>
        <dd data-testid="site-grant-tracking">{grant.tracked.join(", ")}</dd>
      {/if}
      {#if grant.login.length}
        <dt>{ts("chrome-grant-sign-in")}</dt>
        <dd data-testid="site-grant-sign-in">{grant.login.join(", ")}</dd>
      {/if}
      {#if grant.frames.length}
        <dt>{ts("chrome-grant-frames")}</dt>
        <dd data-testid="site-grant-frames">
          {#each grant.frames as c (c)}<code>{c}</code>{/each}
        </dd>
      {/if}
      {#if grant.files.length}
        <dt>{ts("chrome-grant-injects")}</dt>
        <dd data-testid="site-grant-files">
          {#each grant.files as f (f)}<code>{f}</code>{/each}
        </dd>
      {/if}
    </dl>
    {#if grant.resume}<p data-testid="site-grant-resume">{ts("chrome-grant-resume")}</p>{/if}
    <p class="muted">{ts("chrome-grant-warning")}</p>
    <div class="buttons">
      <button data-testid="refuse-site" disabled={running} onclick={() => choose(false)}>{ts("chrome-grant-refuse")}</button>
      <button data-testid="grant-site" class="main" disabled={running} onclick={() => choose(true)}>{ts("chrome-grant-allow")}</button>
    </div>
  </div>
</section>

<style>
  .zone { flex: 1; display: grid; place-content: center; padding: 16px; min-height: 0; overflow: auto; }
  .card { width: min(480px, 90vw); padding: 18px 20px; border-radius: 16px; background: radial-gradient(120% 90% at 0% 0%, color-mix(in oklab, var(--a1) 20%, transparent), transparent 60%), radial-gradient(110% 80% at 100% 0%, color-mix(in oklab, var(--a2) 14%, transparent), transparent 55%), var(--glass-dense); backdrop-filter: blur(30px) saturate(1.8); border: 1px solid var(--glass-edge); color: var(--text); box-shadow: var(--modal-shadow); animation: ressac-drop var(--spring-d) var(--spring) backwards; }
  h2 { margin: 0 0 12px; font: 600 17px/1.25 var(--font-display); letter-spacing: -0.01em; overflow-wrap: anywhere; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 6px 12px; margin: 0 0 12px; font-size: 13px; }
  dt { color: var(--text-muted); }
  dd { margin: 0; display: flex; flex-wrap: wrap; gap: 4px 8px; overflow-wrap: anywhere; min-width: 0; }
  code { font: 12px var(--font-mono); padding: 1px 5px; border-radius: 6px; background: var(--glass-hi); overflow-wrap: anywhere; }
  p { margin: 0 0 12px; font-size: 13px; }
  .muted { color: var(--text-muted); }
  .buttons { display: flex; justify-content: flex-end; gap: 8px; }
  .buttons button { padding: 7px 14px; border-radius: 10px; border: 1px solid var(--border); background: var(--glass-hi); color: var(--text); font: 600 12.5px var(--font-ui); cursor: pointer; -webkit-app-region: no-drag; transition: transform var(--tap), background var(--tap); }
  .buttons button:active:not(:disabled) { transform: scale(0.97); }
  .buttons .main { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
  .buttons button:disabled { opacity: 0.5; }
  .card:not([data-armed]) .buttons button { pointer-events: none; }
</style>
