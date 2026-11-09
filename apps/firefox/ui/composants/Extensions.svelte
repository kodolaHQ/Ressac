<script lang="ts">
  import type { LigneExtension } from "../../shared/extensions";
  import { activeDans, CONSOLE_DEBLOQUEE_PAGE, DESACTIVEE_PLANTAGES, DESACTIVEE_PORTEE } from "../../shared/extensions-messages";
  import type { ResultatExtension } from "../../shared/api";
  import { api } from "../etat.svelte";

  // Everything from a manifest or a console is shown as text (never {@html}): it is data.
  let lignes = $state<LigneExtension[]>([]);
  let coupees = $state(false);
  let chargee = $state(false);
  let saisie = $state("");
  let message = $state<string | null>(null);
  let details = $state<Record<string, boolean>>({});
  /** Extension whose deletion awaits the user's confirmation. */
  let aSupprimer = $state<LigneExtension | null>(null);
  let requete = 0;

  async function charger() {
    const n = ++requete;
    const [l, b] = await Promise.all([api.extensions.liste(), api.extensions.coupees()]);
    if (n !== requete) return;
    lignes = l;
    coupees = b;
    chargee = true;
  }

  $effect(() => {
    void charger();
    return api.extensions.surChange(() => void charger());
  });

  async function faire(p: Promise<ResultatExtension>) {
    message = null;
    const r = await p;
    if (!r.ok) message = r.erreur;
    await charger();
  }

  async function ajouter(e: SubmitEvent) {
    e.preventDefault();
    const texte = saisie.trim();
    if (!texte) return;
    message = null;
    const r = await api.extensions.installerStore(texte);
    if (r.ok) saisie = "";
    else message = r.erreur;
    await charger();
  }

  const date = (iso: string) => new Date(iso).toLocaleString("fr-FR", { dateStyle: "medium", timeStyle: "short" });
  const espaces = (l: LigneExtension) => (l.espaces.length ? l.espaces.map((e) => `« ${e.nom} » (profil ${e.profil})`).join(", ") : l.applis.length ? "aucun" : "Active nulle part");
</script>

<section class="extensions" data-testid="page-extensions" aria-label="Extensions">
  <header>
    <h1>Extensions</h1>
    <label class="coupure">
      <input
        type="checkbox"
        role="switch"
        data-testid="couper-extensions"
        checked={coupees}
        onchange={(e) => void faire(api.extensions.toutCouper(e.currentTarget.checked))}
      />
      Désactiver toutes les extensions
    </label>
  </header>
  <form class="ajout" onsubmit={ajouter}>
    <label>
      Ajouter depuis le Chrome Web Store
      <input data-testid="ajout-store" bind:value={saisie} placeholder="Adresse de sa page ou identifiant" spellcheck="false" />
    </label>
    <button type="submit">Ajouter</button>
  </form>
  {#if message}<p class="message" role="status" data-testid="message-extensions">{message}</p>{/if}
  {#if coupees}<p class="bandeau" role="status">Toutes les extensions sont désactivées : aucune n'est chargée, même après un redémarrage.</p>{/if}
  {#if chargee && lignes.length === 0}
    <p class="vide">Aucune extension. Ajoute-en une depuis le Chrome Web Store, ou demande à l'agent d'en écrire une.</p>
  {/if}
  <ul>
    {#each lignes as l (l.cle)}
      <li data-testid="extension-page" data-cle={l.cle}>
        <div class="tete">
          <b>{l.nom}</b>
          <span class="doux">{l.source === "store" ? "Chrome Web Store" : "Écrite par l'agent"} · {l.version}</span>
        </div>
        {#if l.desactivee}<p class="alerte">{l.desactivee}</p>{/if}
        {#if l.consoleDebloquee}<p class="alerte" data-testid="console-debloquee">{CONSOLE_DEBLOQUEE_PAGE}</p>{/if}
        {#if l.majEnAttente}<p class="doux">Mise à jour {l.majEnAttente} en attente de ton accord.</p>{/if}
        <p>Droits : {l.droits.length ? l.droits.join(" · ") : "aucun"}</p>
        <p>Sites : {l.tousLesSites ? "tous les sites" : l.sites.length ? l.sites.join(", ") : "aucun"}</p>
        <p>Espaces : {espaces(l)}</p>
        {#if l.applis.length}<p data-testid="extension-applis">{activeDans(l.applis)}</p>{/if}
        {#if l.modifieeLe}<p class="doux">Modifiée le {date(l.modifieeLe)}</p>{/if}
        {#if l.nonPrisEnCharge.length}<p class="doux">Non pris en charge : {l.nonPrisEnCharge.join(", ")}</p>{/if}
        {#if l.erreurs.length}
          <p class="alerte">Erreurs : {details[l.cle] ? l.erreurs.join(" ; ") : l.erreurs[l.erreurs.length - 1]}</p>
        {/if}
        {#if details[l.cle]}
          <dl class="details" data-testid="details-extension">
            <dt>Clé</dt>
            <dd>{l.cle}</dd>
            <dt>Droits</dt>
            <dd>{#each l.droits as d (d)}<span>{d}</span>{:else}aucun{/each}</dd>
            <dt>Sites</dt>
            <dd>{#each l.sites as s (s)}<span>{s}</span>{:else}aucun{/each}</dd>
            <dt>Erreurs</dt>
            <dd>{#each l.erreurs as e, i (i)}<span>{e}</span>{:else}aucune{/each}</dd>
          </dl>
        {/if}
        <div class="actions">
          {#if l.majEnAttente}<button onclick={() => void faire(api.extensions.revoir(l.cle))}>Revoir la mise à jour</button>{/if}
          {#if l.source === "agent" && l.desactivee === DESACTIVEE_PORTEE}
            <button onclick={() => void faire(api.extensions.revoir(l.cle))}>Revoir l'accord</button>
          {/if}
          {#if l.desactivee === DESACTIVEE_PLANTAGES}<button onclick={() => void faire(api.extensions.reactiver(l.cle))}>Réactiver</button>{/if}
          {#if l.consoleDebloquee}<button onclick={() => void faire(api.extensions.couperDeblocage(l.cle))}>Couper le déblocage</button>{/if}
          <button disabled={l.espaces.length === 0 && l.applis.length === 0} onclick={() => void faire(api.extensions.desactiverPartout(l.cle))}>Désactiver partout</button>
          <button onclick={() => (aSupprimer = l)}>Supprimer</button>
          <button aria-expanded={!!details[l.cle]} onclick={() => (details[l.cle] = !details[l.cle])}>Détails</button>
        </div>
      </li>
    {/each}
  </ul>
</section>
{#if aSupprimer}
  {@const cible = aSupprimer}
  <div class="voile">
    <div class="confirmation" role="alertdialog" aria-modal="true" data-testid="confirmation-suppression-extension">
      <p>
        Supprimer « {cible.nom} » ? {cible.source === "store"
          ? "Elle sera désinstallée de tous les profils."
          : "Son accord et sa copie seront effacés ; le dossier de l'agent reste."}
      </p>
      <div class="boutons">
        <button onclick={() => (aSupprimer = null)}>Annuler</button>
        <button
          class="confirmer"
          onclick={() => {
            const cle = cible.cle; // {@const} is re-read: after aSupprimer = null, cible is null
            aSupprimer = null;
            void faire(api.extensions.supprimer(cle));
          }}>Supprimer</button
        >
      </div>
    </div>
  </div>
{/if}

<style>
  .extensions { height: 100%; overflow-y: auto; padding: 20px 24px; box-sizing: border-box; color: var(--texte); }
  header { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 14px; }
  h1 { margin: 0; font-size: 18px; }
  .coupure { display: flex; align-items: center; gap: 8px; }
  .ajout { display: flex; align-items: flex-end; gap: 8px; margin-bottom: 14px; }
  .ajout label { flex: 1; display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--texte-doux); }
  .ajout input { padding: 7px 10px; border-radius: 8px; border: 1px solid var(--bord); background: var(--fond-barre); color: var(--texte); outline: none; }
  .ajout input:focus { border-color: var(--accent); }
  button { padding: 4px 10px; border-radius: 6px; border: 1px solid var(--bord); background: var(--fond-barre); color: var(--texte); font-size: 12px; }
  button:hover:not(:disabled) { background: var(--fond-survol); }
  button:disabled { opacity: 0.5; }
  .message, .bandeau { margin: 0 0 14px; padding: 8px 12px; border-radius: 8px; background: var(--fond-actif); }
  .vide, .doux { color: var(--texte-doux); }
  ul { list-style: none; margin: 0; padding: 0; }
  li { padding: 12px 8px; border-bottom: 1px solid var(--bord); }
  li p { margin: 4px 0; font-size: 13px; overflow-wrap: anywhere; }
  .tete { display: flex; align-items: baseline; gap: 10px; }
  .tete .doux { font-size: 12px; }
  .alerte { color: var(--en-erreur); }
  .actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
  .details { display: grid; grid-template-columns: max-content 1fr; gap: 4px 12px; margin: 8px 0; font-size: 12px; }
  .details dt { color: var(--texte-doux); }
  .details dd { margin: 0; display: flex; flex-direction: column; overflow-wrap: anywhere; }
  .voile { position: fixed; inset: 0; display: grid; place-content: center; background: rgb(0 0 0 / 0.35); z-index: 10; }
  .confirmation { max-width: 420px; padding: 16px 20px; border-radius: 10px; background: var(--fond-barre); border: 1px solid var(--bord); color: var(--texte); }
  .confirmation p { margin: 0 0 14px; }
  .boutons { display: flex; justify-content: flex-end; gap: 8px; }
  .boutons .confirmer { background: var(--accent); border-color: var(--accent); color: white; }
</style>
