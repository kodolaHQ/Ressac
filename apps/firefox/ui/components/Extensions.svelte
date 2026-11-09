<script lang="ts">
  import type { ExtensionLine } from "../../shared/extensions";
  import { activeIn, CONSOLE_UNLOCKED_PAGE, DISABLED_CRASHES, DISABLED_SCOPE } from "../../shared/extensions-messages";
  import type { ExtensionResult } from "../../shared/api";
  import { api } from "../state.svelte";

  // Everything from a manifest or a console is shown as text (never {@html}): it is data.
  let lignes = $state<ExtensionLine[]>([]);
  let cuts = $state(false);
  let chargee = $state(false);
  let input = $state("");
  let message = $state<string | null>(null);
  let details = $state<Record<string, boolean>>({});
  /** Extension whose deletion awaits the user's confirmation. */
  let toDelete = $state<ExtensionLine | null>(null);
  let request = 0;

  async function load() {
    const n = ++request;
    const [l, b] = await Promise.all([api.extensions.list(), api.extensions.cut()]);
    if (n !== request) return;
    lignes = l;
    cuts = b;
    chargee = true;
  }

  $effect(() => {
    void load();
    return api.extensions.onChange(() => void load());
  });

  async function make(p: Promise<ExtensionResult>) {
    message = null;
    const r = await p;
    if (!r.ok) message = r.error;
    await load();
  }

  async function add(e: SubmitEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text) return;
    message = null;
    const r = await api.extensions.installStore(text);
    if (r.ok) input = "";
    else message = r.error;
    await load();
  }

  const date = (iso: string) => new Date(iso).toLocaleString("fr-FR", { dateStyle: "medium", timeStyle: "short" });
  const spaces = (l: ExtensionLine) => (l.spaces.length ? l.spaces.map((e) => `« ${e.name} » (profil ${e.profile})`).join(", ") : l.siteApps.length ? "aucun" : "Active nulle part");
</script>

<section class="extensions" data-testid="page-extensions" aria-label="Extensions">
  <header>
    <h1>Extensions</h1>
    <label class="coupure">
      <input
        type="checkbox"
        role="switch"
        data-testid="couper-extensions"
        checked={cuts}
        onchange={(e) => void make(api.extensions.cutAll(e.currentTarget.checked))}
      />
      Désactiver toutes les extensions
    </label>
  </header>
  <form class="ajout" onsubmit={add}>
    <label>
      Ajouter depuis le Chrome Web Store
      <input data-testid="ajout-store" bind:value={input} placeholder="Adresse de sa page ou identifiant" spellcheck="false" />
    </label>
    <button type="submit">Ajouter</button>
  </form>
  {#if message}<p class="message" role="status" data-testid="message-extensions">{message}</p>{/if}
  {#if cuts}<p class="bandeau" role="status">Toutes les extensions sont désactivées : aucune n'est chargée, même après un redémarrage.</p>{/if}
  {#if chargee && lignes.length === 0}
    <p class="vide">Aucune extension. Ajoute-en une depuis le Chrome Web Store, ou demande à l'agent d'en écrire une.</p>
  {/if}
  <ul>
    {#each lignes as l (l.key)}
      <li data-testid="extension-page" data-cle={l.key}>
        <div class="tete">
          <b>{l.name}</b>
          <span class="doux">{l.source === "store" ? "Chrome Web Store" : "Écrite par l'agent"} · {l.version}</span>
        </div>
        {#if l.disabled}<p class="alerte">{l.disabled}</p>{/if}
        {#if l.consoleUnlocked}<p class="alerte" data-testid="console-debloquee">{CONSOLE_UNLOCKED_PAGE}</p>{/if}
        {#if l.pendingUpdate}<p class="doux">Mise à jour {l.pendingUpdate} en attente de ton accord.</p>{/if}
        <p>Droits : {l.rights.length ? l.rights.join(" · ") : "aucun"}</p>
        <p>Sites : {l.allSites ? "tous les sites" : l.sites.length ? l.sites.join(", ") : "aucun"}</p>
        <p>Espaces : {spaces(l)}</p>
        {#if l.siteApps.length}<p data-testid="extension-applis">{activeIn(l.siteApps)}</p>{/if}
        {#if l.modifiedAt}<p class="doux">Modifiée le {date(l.modifiedAt)}</p>{/if}
        {#if l.unsupported.length}<p class="doux">Non pris en charge : {l.unsupported.join(", ")}</p>{/if}
        {#if l.errors.length}
          <p class="alerte">Erreurs : {details[l.key] ? l.errors.join(" ; ") : l.errors[l.errors.length - 1]}</p>
        {/if}
        {#if details[l.key]}
          <dl class="details" data-testid="details-extension">
            <dt>Clé</dt>
            <dd>{l.key}</dd>
            <dt>Droits</dt>
            <dd>{#each l.rights as d (d)}<span>{d}</span>{:else}aucun{/each}</dd>
            <dt>Sites</dt>
            <dd>{#each l.sites as s (s)}<span>{s}</span>{:else}aucun{/each}</dd>
            <dt>Erreurs</dt>
            <dd>{#each l.errors as e, i (i)}<span>{e}</span>{:else}aucune{/each}</dd>
          </dl>
        {/if}
        <div class="actions">
          {#if l.pendingUpdate}<button onclick={() => void make(api.extensions.review(l.key))}>Revoir la mise à jour</button>{/if}
          {#if l.source === "agent" && l.disabled === DISABLED_SCOPE}
            <button onclick={() => void make(api.extensions.review(l.key))}>Revoir l'accord</button>
          {/if}
          {#if l.disabled === DISABLED_CRASHES}<button onclick={() => void make(api.extensions.reactivate(l.key))}>Réactiver</button>{/if}
          {#if l.consoleUnlocked}<button onclick={() => void make(api.extensions.cutUnlock(l.key))}>Couper le déblocage</button>{/if}
          <button disabled={l.spaces.length === 0 && l.siteApps.length === 0} onclick={() => void make(api.extensions.disableEverywhere(l.key))}>Désactiver partout</button>
          <button onclick={() => (toDelete = l)}>Supprimer</button>
          <button aria-expanded={!!details[l.key]} onclick={() => (details[l.key] = !details[l.key])}>Détails</button>
        </div>
      </li>
    {/each}
  </ul>
</section>
{#if toDelete}
  {@const target = toDelete}
  <div class="voile">
    <div class="confirmation" role="alertdialog" aria-modal="true" data-testid="confirmation-suppression-extension">
      <p>
        Supprimer « {target.name} » ? {target.source === "store"
          ? "Elle sera désinstallée de tous les profils."
          : "Son accord et sa copie seront effacés ; le dossier de l'agent reste."}
      </p>
      <div class="boutons">
        <button onclick={() => (toDelete = null)}>Annuler</button>
        <button
          class="confirmer"
          onclick={() => {
            const key = target.key; // {@const} is re-read: after toDelete = null, cible is null
            toDelete = null;
            void make(api.extensions.supprimer(key));
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
