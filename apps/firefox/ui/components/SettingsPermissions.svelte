<script lang="ts">
  import type { GrantRow } from "../../shared/settings";
  import { profileLabel } from "../home-profiles";
  import { api, appState } from "../state.svelte";

  // Styles come from Settings.svelte.
  let rows = $state<GrantRow[] | null>(null);
  /** A widget or action grant whose removal awaits confirmation. */
  let asking = $state<GrantRow | null>(null);
  const load = async () => (rows = await api.settings.grants());
  $effect(() => void load());

  async function revoke(r: GrantRow) {
    asking = null;
    await api.settings.revoke(r.kind, r.key);
    await load();
  }
</script>

<section data-testid="settings-permissions">
  <h2>Permissions</h2>
  {#if !rows}
    <p class="muted">Vérification…</p>
  {:else if rows.length === 0}
    <p class="muted">Aucun accès accordé.</p>
  {:else}
    {#each rows as r (`${r.kind}:${r.key}`)}
      <div data-testid="grant-row" data-kind={r.kind}>
        <div class="row">
          <div class="grow">
            <b>{r.name}</b>
            <span class="muted">{r.detail}</span>
            {#if r.profile && appState.value}<span class="muted">{profileLabel(appState.value, r.profile)}</span>{/if}
          </div>
          <button data-testid="grant-revoke" onclick={() => (r.kind === "widget" || r.kind === "action" ? (asking = r) : void revoke(r))}>Retirer</button>
        </div>
        {#if asking?.kind === r.kind && asking.key === r.key}
          <div class="confirmation" role="alertdialog" aria-label="Retirer">
            <p>Les données lues avec ce compte sont effacées.</p>
            <div class="buttons">
              <button onclick={() => (asking = null)}>Annuler</button>
              <button class="confirm" data-testid="confirm-grant" onclick={() => void revoke(r)}>Retirer</button>
            </div>
          </div>
        {/if}
      </div>
    {/each}
  {/if}
  <p class="muted">Les accès éphémères aux onglets ne sont pas listés.</p>
</section>
