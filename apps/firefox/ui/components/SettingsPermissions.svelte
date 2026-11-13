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

  /** null: not asked; then whether macOS forgot its screen recording grant. */
  let repaired = $state<boolean | null>(null);
</script>

<section data-testid="settings-permissions">
  <h2>Permissions</h2>
  {#if !rows}
    <p><span class="pill" data-tone="warn">Vérification…</span></p>
  {:else}
    <div class="panel">
      {#each rows as r (`${r.kind}:${r.key}`)}
        <div data-testid="grant-row" data-kind={r.kind}>
          <div class="row">
            <div class="grow">
              <b>{r.name}</b>
              <span class="muted">{r.detail}</span>
              {#if r.profile && appState.value}<span class="muted">{profileLabel(appState.value, r.profile)}</span>{/if}
            </div>
            <button class="danger" data-testid="grant-revoke" onclick={() => (r.kind === "widget" || r.kind === "action" ? (asking = r) : void revoke(r))}>Retirer</button>
          </div>
          {#if asking?.kind === r.kind && asking.key === r.key}
            <div class="confirmation" role="alertdialog" aria-label="Retirer">
              <p>Les données lues avec ce compte sont effacées.</p>
              <div class="buttons">
                <button onclick={() => (asking = null)}>Annuler</button>
                <button class="primary" data-testid="confirm-grant" onclick={() => void revoke(r)}>Retirer</button>
              </div>
            </div>
          {/if}
        </div>
      {:else}
        <div class="row muted">Aucun accès accordé.</div>
      {/each}
    </div>
  {/if}
  <p class="muted">Les accès éphémères aux onglets ne sont pas listés.</p>
  <h2>Partage d'écran</h2>
  <div class="panel">
    <div class="row" data-testid="screen-sharing-repair">
      <div class="grow">
        <b>Le partage d'écran ne marche plus</b>
        <span class="muted">
          {#if repaired}
            Quittez puis rouvrez Ressac. Au prochain partage, macOS redemandera l'autorisation.
          {:else if repaired === false}
            La réparation a échoué. Dans Réglages Système › Confidentialité et sécurité › Enregistrement de l'écran, retirez Ressac puis relancez-le.
          {:else}
            Après une mise à jour, macOS peut bloquer le partage alors qu'il paraît autorisé. Réparer lui fait redemander l'autorisation.
          {/if}
        </span>
      </div>
      {#if repaired}
        <span class="pill" data-tone="ok">Réparé</span>
      {:else}
        <button data-testid="screen-sharing-repair-button" onclick={async () => (repaired = await api.settings.repairScreenSharing())}>Réparer</button>
      {/if}
    </div>
  </div>
</section>
