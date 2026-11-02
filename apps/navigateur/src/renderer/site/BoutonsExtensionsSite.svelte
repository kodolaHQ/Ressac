<script lang="ts">
  import type { BarreExtensions } from "../../commun/extensions";
  import type { ApiSite } from "../../commun/api";

  // Les boutons des extensions chargées dans la session de l'appli (`persist:site-<id>`) : `<button is="browser-action">`
  // de la bibliothèque (injectBrowserAction, preload de l'interface), qui en tire l'icône (crx:), le titre, le badge et
  // la popup. Seulement en vue « site » : sur l'accueil ou la carte d'accord, la popup n'aurait aucun onglet affiché.
  let { api, surSite }: { api: ApiSite; surSite: boolean } = $props();
  let barre = $state<BarreExtensions>({ partition: "", onglet: null, actions: [] });
  /** Change à chaque nouvel état des boutons (titre, icône, badge) : les boutons sont recréés et se relisent. */
  let version = $state(0);
  let requete = 0;

  async function charger() {
    const n = ++requete;
    const r = await api.extensions.barre().catch(() => null);
    if (!r) return;
    // Un bouton seul ne lit pas l'état de la bibliothèque : il est lu ici, avant de les poser (comme BarreExtensions).
    if (r.partition && r.actions.length > 0) await window.browserAction?.getState(r.partition).catch(() => undefined);
    if (n !== requete) return;
    barre = r;
    version++;
  }

  // La bibliothèque prévient des changements (titre, badge, icône) de la partition observée. Un seul écouteur pour la
  // vie de la barre (une fonction passée au monde isolé n'est pas sûrement retrouvée au retrait).
  let ecoute = false;
  $effect(() => {
    const p = barre.partition;
    const ba = window.browserAction;
    if (!p || !ba || barre.actions.length === 0) return;
    if (!ecoute) {
      ecoute = true;
      ba.addEventListener("update", () => version++);
    }
    ba.addObserver(p);
    return () => ba.removeObserver(p);
  });

  $effect(() => {
    // Relus à chaque changement de vue (l'onglet n'est donné qu'en vue « site »).
    void surSite;
    void charger();
  });
  $effect(() => api.extensions.surChange(() => void charger()));
</script>

{#if surSite && barre.onglet !== null}
  {#key version}
    {#each barre.actions as a (a.cle)}
      <!-- Alignement par défaut de la bibliothèque : la barre de l'appli est à droite, la popup s'aligne sur le bord
           droit du bouton. Le nom vient de l'extension : en texte (attribut), jamais en HTML. -->
      <!-- svelte-ignore attribute_avoid_is -->
      <button
        is="browser-action"
        class="action"
        id={a.idChrome}
        partition={barre.partition}
        tab={barre.onglet ?? -1}
        data-testid="action-extension-site"
        data-cle={a.cle}
        aria-label={a.nom}
      ></button>
    {/each}
  {/key}
{/if}

<style>
  .action { all: unset; position: relative; width: 24px; height: 24px; flex: none; border-radius: 5px; background-position: center; background-repeat: no-repeat; background-size: 16px; -webkit-app-region: no-drag; }
  .action:hover { background-color: var(--fond-survol); }
  /* Sans icône : la première lettre du titre (data-letter, posé par la bibliothèque). */
  :global(.action.no-icon)::after { content: attr(data-letter); position: absolute; inset: 4px; display: grid; place-content: center; border-radius: 4px; background: var(--fond-actif); color: var(--texte); font-size: 10px; text-transform: uppercase; }
  :global(.action .badge) { position: absolute; right: 0; bottom: 0; padding: 0 2px; border-radius: 2px; font-size: 9px; line-height: 12px; pointer-events: none; }
</style>
