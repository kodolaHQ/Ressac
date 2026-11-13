<script lang="ts">
  import type { Execution } from "@ressac/kernel";
  import type { ActionShown } from "../../shared/actions";
  import { api } from "../state.svelte";
  import Icon from "./Icon.svelte";

  const STATUSES: Record<Execution["status"], string> = {
    succeeded: "Réussie",
    partial: "Partielle",
    failed: "Échouée",
    interrupted: "Interrompue",
    "grant-required": "Accord requis",
  };

  /** Same text as the kernel (actions/run.ts). */
  const requiredInput = (label: string) => `Saisie requise : ${label}`;

  let list = $state<ActionShown[]>([]);
  let chargee = $state(false);
  let request = 0;
  /** Action whose input is asked inline (« Lancer »), and what the user types in it. */
  let inputOf = $state<string | null>(null);
  let input = $state("");
  /** Action whose deletion awaits the user's confirmation. */
  let toConfirm = $state<{ action: ActionShown; kind: "delete" | "grant" } | null>(null);
  /** Refusal returned by the main process (open, delete), shown above the list. */
  let denial = $state<string | null>(null);

  async function load() {
    const n = ++request;
    const r = await api.actions.list();
    if (n !== request) return;
    list = r;
    chargee = true;
  }

  $effect(() => {
    void load();
    return api.actions.onChange(() => void load());
  });

  async function launch(a: ActionShown, text: string | null) {
    denial = null;
    // Input required and empty: the field stays open with its message, nothing is launched.
    if (a.input && !text?.trim()) {
      denial = requiredInput(a.input.label);
      return;
    }
    inputOf = null;
    const r = await api.actions.open(a.id, text);
    if (!r.ok) denial = r.error;
  }

  function requestLaunch(a: ActionShown) {
    if (a.input) {
      inputOf = inputOf === a.id ? null : a.id;
      input = "";
    } else void launch(a, null);
  }

  async function confirm(c: { action: ActionShown; kind: "delete" | "grant" }) {
    toConfirm = null;
    denial = null;
    if (c.kind === "grant") await api.actions.denyGrant(c.action.id);
    else {
      const r = await api.actions.delete(c.action.id);
      if (!r.ok) denial = r.error;
    }
    await load();
  }

  /** « 30 oct. 08:00 » */
  const when = (iso: string) => new Date(iso).toLocaleString("fr-FR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

  const last = (a: ActionShown) => (a.last ? `${STATUSES[a.last.status]} · ${when(a.last.start)}` : "Jamais lancée");
</script>

<section class="actions" data-testid="page-actions" aria-label="Actions">
  <h1>Actions</h1>
  {#if denial}<p class="banner" role="status" data-testid="actions-refusal">{denial}</p>{/if}
  {#if chargee && list.length === 0}
    <p class="empty">Aucune action. Demande à l'agent de t'en créer une.</p>
  {:else}
    <ul>
      {#each list as a (a.id)}
        <li data-testid="action-row-{a.id}">
          <div class="name">
            <b>{a.name}</b>
            {#if a.error}
              <span class="error" data-testid="error-{a.id}">{a.error}</span>
            {:else}
              {#if a.keywords.length}<span data-testid="keywords-{a.id}">{a.keywords.join(", ")}</span>{/if}
              <span class="latest" data-testid="latest-{a.id}">{last(a)}</span>
            {/if}
            {#if inputOf === a.id && a.input}
              <!-- svelte-ignore a11y_autofocus -->
              <input
                class="input"
                data-testid="input-{a.id}"
                placeholder={a.input.label}
                aria-label={a.input.label}
                spellcheck="false"
                autofocus
                bind:value={input}
                onkeydown={(e) => {
                  if (e.key === "Enter") void launch(a, input);
                  else if (e.key === "Escape") inputOf = null;
                }}
              />
            {/if}
          </div>
          <div class="buttons">
            {#if !a.error}
              <button data-testid="launch-{a.id}" onclick={() => requestLaunch(a)}><Icon name="actions" size={12} /> Lancer</button>
            {/if}
            <button data-testid="show-workflow-{a.id}" onclick={() => api.actions.viewWorkflow(a.id)}>Voir le workflow</button>
            {#if a.grant}<button data-testid="remove-grant-{a.id}" onclick={() => (toConfirm = { action: a, kind: "grant" })}>Retirer l'accord</button>{/if}
            <button data-testid="delete-{a.id}" onclick={() => (toConfirm = { action: a, kind: "delete" })}>Supprimer</button>
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</section>

{#if toConfirm}
  {@const c = toConfirm}
  {@const target = c.action}
  <div class="veil" data-testid="action-delete-veil">
    <div class="confirmation" role="alertdialog" aria-modal="true" data-testid="action-delete-confirmation">
      {#if c.kind === "grant"}
        <p>Retirer l'accord de « {target.name} » ? Ses exécutions, ses résultats et sa mémoire seront effacés.</p>
      {:else}
        <p>Supprimer « {target.name} » ? Son dossier ira dans la corbeille ; ses résultats et son accord seront effacés.</p>
      {/if}
      <div class="confirm-buttons">
        <button data-testid="cancel-action-delete" onclick={() => (toConfirm = null)}>Annuler</button>
        <button class="confirm" data-testid="confirm-action-delete" onclick={() => void confirm(c)}>{c.kind === "grant" ? "Retirer l'accord" : "Supprimer"}</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .actions { height: 100%; overflow-y: auto; padding: 26px 32px; color: var(--text); }
  h1 { margin: 0 0 18px; font: 650 26px/1.1 var(--font-display); letter-spacing: -0.02em; }
  .banner { margin: 0 0 14px; padding: 10px 14px; border-radius: 12px; background: var(--attention-bg); }
  .empty { color: var(--text-muted); }
  ul { list-style: none; margin: 0; padding: 0; border: 1px solid var(--border); border-radius: 16px; background: var(--sheet); box-shadow: var(--lift); overflow: hidden; }
  li { display: flex; align-items: center; gap: 12px; padding: 12px 14px; border-top: 1px solid var(--border); }
  li:first-child { border-top: none; }
  .name { flex: 1; min-width: 0; }
  .name b { display: block; font-weight: 600; }
  .name span { display: block; font-size: 12px; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .name .error { color: var(--in-error); white-space: normal; }
  .input { all: unset; box-sizing: border-box; width: 100%; max-width: 360px; margin-top: 6px; padding: 6px 10px; border: 1px solid var(--border); border-radius: 10px; background: var(--glass-hi); }
  .input:focus { border-color: var(--accent); }
  .buttons { display: flex; gap: 6px; flex: none; }
  .buttons button, .confirmation button { display: inline-flex; align-items: center; gap: 4px; padding: 5px 11px; border-radius: 10px; border: 1px solid var(--border); background: var(--glass-hi); color: var(--text); font: 600 12px var(--font-ui); transition: transform var(--tap), background var(--tap); }
  .buttons button:hover { background: var(--bg-active); }
  :is(.buttons, .confirmation) button:active { transform: scale(0.97); }
  .veil { position: fixed; inset: 0; -webkit-app-region: no-drag; display: grid; place-content: center; background: var(--veil); backdrop-filter: blur(6px); z-index: 10; }
  .confirmation { max-width: 420px; padding: 18px 20px; border-radius: 16px; background: var(--glass-dense); border: 1px solid var(--glass-edge); box-shadow: var(--modal-shadow); color: var(--text); animation: ressac-drop var(--spring-d) var(--spring) backwards; }
  .confirmation p { margin: 0 0 14px; }
  .confirm-buttons { display: flex; justify-content: flex-end; gap: 8px; }
  .confirmation .confirm { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
</style>
