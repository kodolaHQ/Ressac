<script lang="ts">
  import type { Execution } from "@webaios/noyau";
  import type { ActionShown } from "../../shared/actions";
  import { api } from "../etat.svelte";
  import Icon from "./Icone.svelte";

  const STATUSES: Record<Execution["statut"], string> = {
    reussie: "Réussie",
    partielle: "Partielle",
    echouee: "Échouée",
    interrompue: "Interrompue",
    "accord-requis": "Accord requis",
  };

  /** Same text as the kernel (actions/executer.ts). */
  const requiredInput = (label: string) => `Saisie requise : ${label}`;

  let list = $state<ActionShown[]>([]);
  let chargee = $state(false);
  let request = 0;
  /** Action whose input is asked inline (« Lancer »), and what the user types in it. */
  let inputOf = $state<string | null>(null);
  let input = $state("");
  /** Action whose deletion awaits the user's confirmation. */
  let aConfirmer = $state<{ action: ActionShown; genre: "supprimer" | "accord" } | null>(null);
  /** Refusal returned by the main process (open, delete), shown above the list. */
  let denial = $state<string | null>(null);

  async function charger() {
    const n = ++request;
    const r = await api.actions.liste();
    if (n !== request) return;
    list = r;
    chargee = true;
  }

  $effect(() => {
    void charger();
    return api.actions.surChange(() => void charger());
  });

  async function lancer(a: ActionShown, text: string | null) {
    denial = null;
    // Input required and empty: the field stays open with its message, nothing is launched.
    if (a.saisie && !text?.trim()) {
      denial = requiredInput(a.saisie.libelle);
      return;
    }
    inputOf = null;
    const r = await api.actions.ouvrir(a.id, text);
    if (!r.ok) denial = r.erreur;
  }

  function requestLaunch(a: ActionShown) {
    if (a.saisie) {
      inputOf = inputOf === a.id ? null : a.id;
      input = "";
    } else void lancer(a, null);
  }

  async function confirmer(c: { action: ActionShown; genre: "supprimer" | "accord" }) {
    aConfirmer = null;
    denial = null;
    if (c.genre === "accord") await api.actions.refuserAccord(c.action.id);
    else {
      const r = await api.actions.supprimer(c.action.id);
      if (!r.ok) denial = r.erreur;
    }
    await charger();
  }

  /** « 30 oct. 08:00 » */
  const when = (iso: string) => new Date(iso).toLocaleString("fr-FR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

  const dernier = (a: ActionShown) => (a.dernier ? `${STATUSES[a.dernier.statut]} · ${when(a.dernier.debut)}` : "Jamais lancée");
</script>

<section class="actions" data-testid="page-actions" aria-label="Actions">
  <h1>Actions</h1>
  {#if denial}<p class="bandeau" role="status" data-testid="refus-actions">{denial}</p>{/if}
  {#if chargee && list.length === 0}
    <p class="vide">Aucune action. Demande à l'agent de t'en créer une.</p>
  {:else}
    <ul>
      {#each list as a (a.id)}
        <li data-testid="ligne-action-{a.id}">
          <div class="nom">
            <b>{a.nom}</b>
            {#if a.erreur}
              <span class="erreur" data-testid="erreur-{a.id}">{a.erreur}</span>
            {:else}
              {#if a.motsCles.length}<span data-testid="mots-cles-{a.id}">{a.motsCles.join(", ")}</span>{/if}
              <span class="dernier" data-testid="dernier-{a.id}">{dernier(a)}</span>
            {/if}
            {#if inputOf === a.id && a.saisie}
              <!-- svelte-ignore a11y_autofocus -->
              <input
                class="saisie"
                data-testid="saisie-{a.id}"
                placeholder={a.saisie.libelle}
                aria-label={a.saisie.libelle}
                spellcheck="false"
                autofocus
                bind:value={input}
                onkeydown={(e) => {
                  if (e.key === "Enter") void lancer(a, input);
                  else if (e.key === "Escape") inputOf = null;
                }}
              />
            {/if}
          </div>
          <div class="boutons">
            {#if !a.erreur}
              <button data-testid="lancer-{a.id}" onclick={() => requestLaunch(a)}><Icon nom="actions" taille={12} /> Lancer</button>
            {/if}
            <button data-testid="voir-workflow-{a.id}" onclick={() => api.actions.voirWorkflow(a.id)}>Voir le workflow</button>
            {#if a.accord}<button data-testid="retirer-accord-{a.id}" onclick={() => (aConfirmer = { action: a, genre: "accord" })}>Retirer l'accord</button>{/if}
            <button data-testid="supprimer-{a.id}" onclick={() => (aConfirmer = { action: a, genre: "supprimer" })}>Supprimer</button>
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</section>

{#if aConfirmer}
  {@const c = aConfirmer}
  {@const target = c.action}
  <div class="voile" data-testid="voile-suppression-action">
    <div class="confirmation" role="alertdialog" aria-modal="true" data-testid="confirmation-suppression-action">
      {#if c.genre === "accord"}
        <p>Retirer l'accord de « {target.nom} » ? Ses exécutions, ses résultats et sa mémoire seront effacés.</p>
      {:else}
        <p>Supprimer « {target.nom} » ? Son dossier ira dans la corbeille ; ses résultats et son accord seront effacés.</p>
      {/if}
      <div class="confirmer-boutons">
        <button data-testid="annuler-suppression-action" onclick={() => (aConfirmer = null)}>Annuler</button>
        <button class="confirmer" data-testid="confirmer-suppression-action" onclick={() => void confirmer(c)}>{c.genre === "accord" ? "Retirer l'accord" : "Supprimer"}</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .actions { height: 100%; overflow-y: auto; padding: 20px 24px; color: var(--texte); }
  h1 { margin: 0 0 14px; font-size: 18px; font-weight: 600; }
  .bandeau { margin: 0 0 14px; padding: 8px 12px; border-radius: 8px; background: var(--fond-actif); }
  .vide { color: var(--texte-doux); }
  ul { list-style: none; margin: 0; padding: 0; }
  li { display: flex; align-items: center; gap: 12px; padding: 10px 8px; border-bottom: 1px solid var(--bord); }
  .nom { flex: 1; min-width: 0; }
  .nom b { display: block; font-weight: 600; }
  .nom span { display: block; font-size: 12px; color: var(--texte-doux); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .nom .erreur { color: var(--en-erreur); white-space: normal; }
  .saisie { all: unset; box-sizing: border-box; width: 100%; max-width: 360px; margin-top: 6px; padding: 5px 8px; border: 1px solid var(--bord); border-radius: 6px; background: var(--fond-barre); }
  .saisie:focus { border-color: var(--accent); }
  .boutons { display: flex; gap: 6px; flex: none; }
  .boutons button, .confirmation button { display: inline-flex; align-items: center; gap: 4px; padding: 4px 10px; border-radius: 6px; border: 1px solid var(--bord); background: var(--fond-barre); color: var(--texte); font-size: 12px; }
  .boutons button:hover { background: var(--fond-survol); }
  .voile { position: fixed; inset: 0; -webkit-app-region: no-drag; display: grid; place-content: center; background: rgb(0 0 0 / 0.35); z-index: 10; }
  .confirmation { max-width: 420px; padding: 16px 20px; border-radius: 10px; background: var(--fond-barre); border: 1px solid var(--bord); color: var(--texte); }
  .confirmation p { margin: 0 0 14px; }
  .confirmer-boutons { display: flex; justify-content: flex-end; gap: 8px; }
  .confirmation .confirmer { background: var(--accent); border-color: var(--accent); color: white; }
</style>
