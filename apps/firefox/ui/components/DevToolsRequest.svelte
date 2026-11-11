<script lang="ts">
  import { untrack } from "svelte";
  import type { DevRight } from "@webaios/kernel";
  import { siteOf, type PendingRequest } from "../../shared/model";
  import { api } from "../state.svelte";

  let { request: request }: { request: PendingRequest } = $props();

  // The four rights, in the card's order. `sensible`: the warning shown below.
  const RIGHTS: { right: DevRight; icon: string; name: string; detail: string; sensitive?: string }[] = [
    { right: "console", icon: "👁", name: "Console et erreurs", detail: "Messages, erreurs JavaScript, avertissements" },
    { right: "network", icon: "👁", name: "Réseau", detail: "Requêtes et réponses de la page", sensitive: "peut contenir des données de connexion" },
    { right: "performance", icon: "👁", name: "Performances et mémoire", detail: "Profilage, instantanés mémoire" },
    { right: "act", icon: "⚡", name: "Agir sur la page", detail: "Exécuter du JavaScript, modifier le DOM, recharger", sensitive: "l'agent peut agir en ton nom sur ce site" },
  ];

  // Pre-checked: what the agent asked for; the user can add or remove some.
  // Initialized once: the list of requests is rebroadcast on each new question, without touching the selection.
  let checked = $state<DevRight[]>(untrack(() => [...(request.rights ?? [])]));

  // Never an exception here: an unreadable origin (about:blank, data:…) is shown as is.
  const site = $derived(siteOf(request.origin));
  const check = (right: DevRight, active: boolean) => (checked = active ? [...checked, right] : checked.filter((d) => d !== right));
</script>

<div data-testid="devtools-request">
  <h3>{request.agent ?? "L'agent"} veut accéder aux outils de développement</h3>
  <div class="site">🔒 {site} · onglet « {request.title ?? site} »</div>
  <div class="reason">« {request.reason} »</div>
  {#each RIGHTS as d (d.right)}
    <label class="right-side">
      <input type="checkbox" data-right={d.right} checked={checked.includes(d.right)} onchange={(e) => check(d.right, e.currentTarget.checked)} />
      <div>
        <b>{d.icon} {d.name}</b>
        <span>{d.detail}</span>
        {#if d.sensitive}<div class="sensitive">⚠ {d.sensitive}</div>{/if}
      </div>
    </label>
  {/each}
  <div class="actions">
    <button onclick={() => api.permissions.answer(request.id, "deny")}>Refuser</button>
    <button class="allow" data-main onclick={() => api.permissions.answer(request.id, "allow", $state.snapshot(checked))}>Autoriser la sélection</button>
  </div>
  <div class="note">Valable pour cette conversation · tombe si l'onglet change de site</div>
</div>

<style>
  h3 { margin: 0 0 4px; font: 600 17px/1.2 var(--font-display); letter-spacing: -0.01em; }
  .site { color: var(--text-muted); font-size: 12px; margin-bottom: 10px; overflow-wrap: anywhere; }
  .reason { background: var(--glass-hi); border: 1px solid var(--border); border-radius: 10px; padding: 8px 10px; font-size: 12px; margin-bottom: 10px; overflow-wrap: anywhere; }
  .right-side { display: flex; gap: 10px; align-items: flex-start; padding: 7px 0; border-top: 1px solid var(--border); }
  .right-side input { margin-top: 3px; }
  .right-side b { display: block; font-size: 13px; }
  .right-side span { color: var(--text-muted); font-size: 11.5px; }
  .sensitive { color: var(--access-act); font-size: 11px; font-weight: 600; }
  .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
  button { padding: 7px 14px; border-radius: 10px; border: 1px solid var(--border); background: var(--glass-hi); color: var(--text); font: 600 12.5px var(--font-ui); cursor: pointer; transition: transform var(--tap), background var(--tap); }
  button:hover:not(:disabled) { background: var(--bg-active); }
  button:active:not(:disabled) { transform: scale(0.97); }
  .allow { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
  .note { color: var(--text-muted); font-size: 11px; margin-top: 10px; }
</style>
