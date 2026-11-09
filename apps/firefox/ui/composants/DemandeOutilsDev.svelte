<script lang="ts">
  import { untrack } from "svelte";
  import type { DroitDev } from "@webaios/noyau";
  import { siteDe, type DemandeEnAttente } from "../../shared/modele";
  import { api } from "../etat.svelte";

  let { demande }: { demande: DemandeEnAttente } = $props();

  // The four rights, in the card's order. `sensible`: the warning shown below.
  const DROITS: { droit: DroitDev; icone: string; nom: string; detail: string; sensible?: string }[] = [
    { droit: "console", icone: "👁", nom: "Console et erreurs", detail: "Messages, erreurs JavaScript, avertissements" },
    { droit: "reseau", icone: "👁", nom: "Réseau", detail: "Requêtes et réponses de la page", sensible: "peut contenir des données de connexion" },
    { droit: "performances", icone: "👁", nom: "Performances et mémoire", detail: "Profilage, instantanés mémoire" },
    { droit: "agir", icone: "⚡", nom: "Agir sur la page", detail: "Exécuter du JavaScript, modifier le DOM, recharger", sensible: "l'agent peut agir en ton nom sur ce site" },
  ];

  // Pre-checked: what the agent asked for; the user can add or remove some.
  // Initialized once: the list of requests is rebroadcast on each new question, without touching the selection.
  let coches = $state<DroitDev[]>(untrack(() => [...(demande.droits ?? [])]));

  // Never an exception here: an unreadable origin (about:blank, data:…) is shown as is.
  const site = $derived(siteDe(demande.origine));
  const cocher = (droit: DroitDev, actif: boolean) => (coches = actif ? [...coches, droit] : coches.filter((d) => d !== droit));
</script>

<div data-testid="demande-outils-dev">
  <h3>{demande.agent ?? "L'agent"} veut accéder aux outils de développement</h3>
  <div class="site">🔒 {site} · onglet « {demande.titre ?? site} »</div>
  <div class="raison">« {demande.raison} »</div>
  {#each DROITS as d (d.droit)}
    <label class="droit">
      <input type="checkbox" data-droit={d.droit} checked={coches.includes(d.droit)} onchange={(e) => cocher(d.droit, e.currentTarget.checked)} />
      <div>
        <b>{d.icone} {d.nom}</b>
        <span>{d.detail}</span>
        {#if d.sensible}<div class="sensible">⚠ {d.sensible}</div>{/if}
      </div>
    </label>
  {/each}
  <div class="actions">
    <button onclick={() => api.permissions.repondre(demande.id, "refuser")}>Refuser</button>
    <button class="autoriser" data-principal onclick={() => api.permissions.repondre(demande.id, "autoriser", $state.snapshot(coches))}>Autoriser la sélection</button>
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
