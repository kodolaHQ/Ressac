<script lang="ts">
  import { untrack } from "svelte";
  import type { DevRight } from "@webaios/kernel";
  import { siteOf, type PendingRequest } from "../../shared/model";
  import { api } from "../state.svelte";

  let { request: request }: { request: PendingRequest } = $props();

  // The four rights, in the card's order. `sensible`: the warning shown below.
  const RIGHTS: { right: DevRight; icon: string; name: string; detail: string; sensitive?: string }[] = [
    { right: "console", icon: "👁", name: "Console et erreurs", detail: "Messages, erreurs JavaScript, avertissements" },
    { right: "reseau", icon: "👁", name: "Réseau", detail: "Requêtes et réponses de la page", sensitive: "peut contenir des données de connexion" },
    { right: "performances", icon: "👁", name: "Performances et mémoire", detail: "Profilage, instantanés mémoire" },
    { right: "agir", icon: "⚡", name: "Agir sur la page", detail: "Exécuter du JavaScript, modifier le DOM, recharger", sensitive: "l'agent peut agir en ton nom sur ce site" },
  ];

  // Pre-checked: what the agent asked for; the user can add or remove some.
  // Initialized once: the list of requests is rebroadcast on each new question, without touching the selection.
  let checked = $state<DevRight[]>(untrack(() => [...(request.rights ?? [])]));

  // Never an exception here: an unreadable origin (about:blank, data:…) is shown as is.
  const site = $derived(siteOf(request.origin));
  const check = (right: DevRight, active: boolean) => (checked = active ? [...checked, right] : checked.filter((d) => d !== right));
</script>

<div data-testid="demande-outils-dev">
  <h3>{request.agent ?? "L'agent"} veut accéder aux outils de développement</h3>
  <div class="site">🔒 {site} · onglet « {request.title ?? site} »</div>
  <div class="raison">« {request.reason} »</div>
  {#each RIGHTS as d (d.right)}
    <label class="droit">
      <input type="checkbox" data-droit={d.right} checked={checked.includes(d.right)} onchange={(e) => check(d.right, e.currentTarget.checked)} />
      <div>
        <b>{d.icon} {d.name}</b>
        <span>{d.detail}</span>
        {#if d.sensitive}<div class="sensible">⚠ {d.sensitive}</div>{/if}
      </div>
    </label>
  {/each}
  <div class="actions">
    <button onclick={() => api.permissions.reply(request.id, "refuser")}>Refuser</button>
    <button class="autoriser" data-principal onclick={() => api.permissions.reply(request.id, "autoriser", $state.snapshot(checked))}>Autoriser la sélection</button>
  </div>
  <div class="note">Valable pour cette conversation · tombe si l'onglet change de site</div>
</div>

<style>
  h3 { margin: 0 0 4px; font-size: 15px; }
  .site { opacity: 0.7; font-size: 12px; margin-bottom: 10px; overflow-wrap: anywhere; }
  .raison { background: var(--fond-barre); border-radius: 8px; padding: 8px 10px; font-size: 12px; margin-bottom: 10px; overflow-wrap: anywhere; }
  .droit { display: flex; gap: 10px; align-items: flex-start; padding: 7px 0; border-top: 1px solid var(--bord); }
  .droit input { margin-top: 3px; }
  .droit b { display: block; font-size: 13px; }
  .droit span { opacity: 0.7; font-size: 11.5px; }
  .sensible { color: #fbbf24; font-size: 11px; font-weight: 600; }
  .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
  button { padding: 6px 12px; border-radius: 7px; border: 1px solid var(--bord); background: var(--fond-barre); color: var(--texte); font-weight: 600; font-size: 12.5px; }
  .autoriser { background: var(--accent); border-color: var(--accent); color: white; }
  .note { opacity: 0.55; font-size: 11px; margin-top: 10px; }
</style>
