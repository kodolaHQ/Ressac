<script lang="ts">
  import { AUTORISER, SANS_RETOUCHES, titreAccordRetouches, type DemandeAccordSite } from "../../shared/sites";

  /**
   * The grant card for the app's tweaks, in its window: what the agent asks for (domains, sign-in, frames,
   * resume) and what it injects. Everything comes from site.json, written by the agent: shown as text, never as HTML.
   */
  let { accord, accorder }: { accord: DemandeAccordSite; accorder: (oui: boolean, empreinte: string) => Promise<void> } = $props();
  let enCours = $state(false);

  const choisir = (oui: boolean) => {
    if (enCours) return;
    enCours = true;
    // The hash of the rights shown: the main process only grants those.
    void accorder(oui, accord.empreinte).finally(() => (enCours = false));
  };
</script>

<section class="zone" data-testid="site-zone-accord">
  <div class="carte" role="dialog" aria-labelledby="titre-accord-site" data-testid="carte-accord-site">
    <h2 id="titre-accord-site">{titreAccordRetouches(accord.nom)}</h2>
    <dl>
      <dt>Domaines</dt>
      <dd data-testid="accord-site-domaines">{accord.domaines.join(", ")}</dd>
      {#if accord.suivis.length}
        <dt>Adresses suivies</dt>
        <dd data-testid="accord-site-suivis">{accord.suivis.join(", ")}</dd>
      {/if}
      {#if accord.connexion.length}
        <dt>Connexion</dt>
        <dd data-testid="accord-site-connexion">{accord.connexion.join(", ")}</dd>
      {/if}
      {#if accord.cadres.length}
        <dt>Cadres</dt>
        <dd data-testid="accord-site-cadres">
          {#each accord.cadres as c (c)}<code>{c}</code>{/each}
        </dd>
      {/if}
      {#if accord.fichiers.length}
        <dt>Injecte</dt>
        <dd data-testid="accord-site-fichiers">
          {#each accord.fichiers as f (f)}<code>{f}</code>{/each}
        </dd>
      {/if}
    </dl>
    {#if accord.reprise}<p data-testid="accord-site-reprise">Reprend les vidéos à la minute</p>{/if}
    <p class="doux">Ses retouches voient et modifient les pages de ces domaines. Une image ajoutée à la page peut encore envoyer des données à un autre site.</p>
    <div class="boutons">
      <button data-testid="refuser-site" disabled={enCours} onclick={() => choisir(false)}>{SANS_RETOUCHES}</button>
      <button data-testid="accorder-site" class="principal" disabled={enCours} onclick={() => choisir(true)}>{AUTORISER}</button>
    </div>
  </div>
</section>

<style>
  .zone { flex: 1; display: grid; place-content: center; padding: 16px; min-height: 0; overflow: auto; }
  .carte { width: min(480px, 90vw); padding: 16px 20px; border-radius: 10px; background: var(--fond-barre); border: 1px solid var(--bord); color: var(--texte); box-shadow: var(--ombre-modale); }
  h2 { margin: 0 0 12px; font-size: 15px; overflow-wrap: anywhere; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 6px 12px; margin: 0 0 12px; font-size: 13px; }
  dt { color: var(--texte-doux); }
  dd { margin: 0; display: flex; flex-wrap: wrap; gap: 4px 8px; overflow-wrap: anywhere; min-width: 0; }
  code { font: 12px ui-monospace, monospace; overflow-wrap: anywhere; }
  p { margin: 0 0 12px; font-size: 13px; }
  .doux { color: var(--texte-doux); }
  .boutons { display: flex; justify-content: flex-end; gap: 8px; }
  .boutons button { padding: 6px 12px; border-radius: 6px; border: 1px solid var(--bord); background: var(--fond); color: var(--texte); -webkit-app-region: no-drag; }
  .boutons .principal { background: var(--accent); border-color: var(--accent); color: white; }
  .boutons button:disabled { opacity: 0.5; }
</style>
