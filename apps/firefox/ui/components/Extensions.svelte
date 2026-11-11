<script lang="ts">
  import type { ExtensionLine } from "../../shared/extensions";
  import { activeIn, CONSOLE_UNLOCKED_PAGE, DISABLED_CRASHES, DISABLED_SCOPE } from "../../shared/extensions-messages";
  import type { ExtensionResult } from "../../shared/api";
  import { api } from "../state.svelte";

  // Everything from a manifest or a console is shown as text (never {@html}): it is data.
  let lines = $state<ExtensionLine[]>([]);
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
    const [l, b] = await Promise.all([api.extensions.list(), api.extensions.allCut()]);
    if (n !== request) return;
    lines = l;
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
    <label class="cutoff">
      <input
        type="checkbox"
        role="switch"
        data-testid="extensions-off"
        checked={cuts}
        onchange={(e) => void make(api.extensions.cutAll(e.currentTarget.checked))}
      />
      Désactiver toutes les extensions
    </label>
  </header>
  <form class="add" onsubmit={add}>
    <label>
      Ajouter depuis le Chrome Web Store
      <input data-testid="store-add" bind:value={input} placeholder="Adresse de sa page ou identifiant" spellcheck="false" />
    </label>
    <button type="submit">Ajouter</button>
  </form>
  {#if message}<p class="message" role="status" data-testid="message-extensions">{message}</p>{/if}
  {#if cuts}<p class="banner" role="status">Toutes les extensions sont désactivées : aucune n'est chargée, même après un redémarrage.</p>{/if}
  {#if chargee && lines.length === 0}
    <p class="empty">Aucune extension. Ajoute-en une depuis le Chrome Web Store, ou demande à l'agent d'en écrire une.</p>
  {/if}
  <ul>
    {#each lines as l (l.key)}
      <li data-testid="extension-page" data-key={l.key}>
        <div class="head">
          <b>{l.name}</b>
          <span class="muted">{l.source === "store" ? "Chrome Web Store" : "Écrite par l'agent"} · {l.version}</span>
        </div>
        {#if l.disabled}<p class="alert">{l.disabled}</p>{/if}
        {#if l.consoleUnlocked}<p class="alert" data-testid="console-unlocked">{CONSOLE_UNLOCKED_PAGE}</p>{/if}
        {#if l.pendingUpdate}<p class="muted">Mise à jour {l.pendingUpdate} en attente de ton accord.</p>{/if}
        <p>Droits : {l.rights.length ? l.rights.join(" · ") : "aucun"}</p>
        <p>Sites : {l.allSites ? "tous les sites" : l.sites.length ? l.sites.join(", ") : "aucun"}</p>
        <p>Espaces : {spaces(l)}</p>
        {#if l.siteApps.length}<p data-testid="extension-apps">{activeIn(l.siteApps)}</p>{/if}
        {#if l.modifiedAt}<p class="muted">Modifiée le {date(l.modifiedAt)}</p>{/if}
        {#if l.unsupported.length}<p class="muted">Non pris en charge : {l.unsupported.join(", ")}</p>{/if}
        {#if l.errors.length}
          <p class="alert">Erreurs : {details[l.key] ? l.errors.join(" ; ") : l.errors[l.errors.length - 1]}</p>
        {/if}
        {#if details[l.key]}
          <dl class="details" data-testid="extension-details">
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
          {#if l.disabled === DISABLED_CRASHES}<button onclick={() => void make(api.extensions.reenable(l.key))}>Réactiver</button>{/if}
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
  <div class="veil">
    <div class="confirmation" role="alertdialog" aria-modal="true" data-testid="extension-delete-confirmation">
      <p>
        Supprimer « {target.name} » ? {target.source === "store"
          ? "Elle sera désinstallée de tous les profils."
          : "Son accord et sa copie seront effacés ; le dossier de l'agent reste."}
      </p>
      <div class="buttons">
        <button onclick={() => (toDelete = null)}>Annuler</button>
        <button
          class="confirm"
          onclick={() => {
            const key = target.key; // {@const} is re-read: after toDelete = null, cible is null
            toDelete = null;
            void make(api.extensions.remove(key));
          }}>Supprimer</button
        >
      </div>
    </div>
  </div>
{/if}

<style>
  .extensions { height: 100%; overflow-y: auto; padding: 26px 32px; box-sizing: border-box; color: var(--text); }
  header { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 18px; }
  h1 { margin: 0; font: 650 26px/1.1 var(--font-display); letter-spacing: -0.02em; }
  .cutoff { display: flex; align-items: center; gap: 8px; }
  .add { display: flex; align-items: flex-end; gap: 8px; margin-bottom: 14px; }
  .add label { flex: 1; display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--text-muted); }
  .add input { padding: 7px 10px; border-radius: 10px; border: 1px solid var(--border); background: var(--glass-hi); color: var(--text); outline: none; }
  .add input:focus { border-color: var(--accent); }
  button { padding: 5px 11px; border-radius: 10px; border: 1px solid var(--border); background: var(--glass-hi); color: var(--text); font: 600 12px var(--font-ui); transition: transform var(--tap), background var(--tap); }
  button:hover:not(:disabled) { background: var(--bg-active); }
  button:active:not(:disabled) { transform: scale(0.97); }
  button:disabled { opacity: 0.5; }
  .message, .banner { margin: 0 0 14px; padding: 10px 14px; border-radius: 12px; background: var(--glass-hi); border: 1px solid var(--border); }
  .empty, .muted { color: var(--text-muted); }
  ul { list-style: none; margin: 0; padding: 0; border: 1px solid var(--border); border-radius: 16px; background: var(--sheet); box-shadow: var(--lift); overflow: hidden; }
  li { padding: 12px 14px; border-top: 1px solid var(--border); }
  li:first-child { border-top: none; }
  ul:not(:has(li)) { display: none; }
  li p { margin: 4px 0; font-size: 13px; overflow-wrap: anywhere; }
  .head { display: flex; align-items: baseline; gap: 10px; }
  .head .muted { font-size: 12px; }
  .alert { color: var(--in-error); }
  .actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
  .details { display: grid; grid-template-columns: max-content 1fr; gap: 4px 12px; margin: 8px 0; font-size: 12px; }
  .details dt { color: var(--text-muted); }
  .details dd { margin: 0; display: flex; flex-direction: column; overflow-wrap: anywhere; }
  .veil { position: fixed; inset: 0; display: grid; place-content: center; background: var(--veil); backdrop-filter: blur(6px); z-index: 10; }
  .confirmation { max-width: 420px; padding: 18px 20px; border-radius: 16px; background: var(--glass-dense); border: 1px solid var(--glass-edge); box-shadow: var(--modal-shadow); color: var(--text); animation: webaios-drop var(--spring-d) var(--spring) backwards; }
  .confirmation p { margin: 0 0 14px; }
  .buttons { display: flex; justify-content: flex-end; gap: 8px; }
  .buttons .confirm { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
</style>
