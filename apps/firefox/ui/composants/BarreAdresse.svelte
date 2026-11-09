<script lang="ts">
  import ExtensionsBar from "../ExtensionsStrip.svelte";
  import DesignButton from "./BoutonDesign.svelte";
  import AccessBadge from "./PastilleAcces.svelte";
  import Icon from "./Icone.svelte";
  import type { WindowState, Visite } from "../../shared/modele";
  import { accessOf, api, appState } from "../etat.svelte";

  let { fenetre: win }: { fenetre: WindowState } = $props();
  const tab = $derived.by(() => {
    const id = win.actif[win.espaceActif];
    return id ? appState.valeur?.onglets[id] : undefined;
  });
  const droitsAgent = $derived(tab ? accessOf(tab.id) : undefined);
  let input = $state<string | null>(null); // non-null during editing
  let champ: HTMLInputElement;
  let suggestions = $state<Visite[]>([]);
  let chosen = $state(-1);
  let request = 0;

  async function suggest(text: string) {
    const n = ++request;
    const r = text.trim() ? await api.historique.rechercher(text.trim(), 6, true) : [];
    if (n === request && input !== null) {
      suggestions = r;
      chosen = -1;
    }
  }

  function closeSuggestions() {
    request++;
    suggestions = [];
    chosen = -1;
  }

  function aller(text: string) {
    api.naviguer(tab?.id ?? null, text);
    input = null;
    closeSuggestions();
    champ.blur();
  }

  function clavier(e: KeyboardEvent) {
    if (e.key === "Escape") champ.blur();
    else if (e.key === "ArrowDown" && suggestions.length) {
      e.preventDefault();
      chosen = (chosen + 1) % suggestions.length;
    } else if (e.key === "ArrowUp" && suggestions.length) {
      e.preventDefault();
      chosen = chosen <= 0 ? suggestions.length - 1 : chosen - 1;
    }
  }

  function hostName(url: string): string {
    try {
      const u = new URL(url);
      return u.protocol === "http:" || u.protocol === "https:" ? u.hostname.replace(/^www\./, "") : url;
    } catch {
      return url;
    }
  }

  function validate(e: SubmitEvent) {
    e.preventDefault();
    const suggestion = suggestions[chosen];
    const text = suggestion?.url ?? input?.trim();
    if (text) aller(text);
    else champ.blur();
  }
</script>

<div class="navigation">
  <button aria-label="Reculer" disabled={!tab?.peutReculer} onclick={() => tab && api.commande(tab.id, "reculer")}><Icon nom="reculer" /></button>
  <button aria-label="Avancer" disabled={!tab?.peutAvancer} onclick={() => tab && api.commande(tab.id, "avancer")}><Icon nom="avancer" /></button>
  {#if tab?.chargement}
    <button aria-label="Arrêter" onclick={() => api.commande(tab.id, "arreter")}><Icon nom="fermer" /></button>
  {:else}
    <button aria-label="Recharger" disabled={!tab} onclick={() => tab && api.commande(tab.id, "recharger")}><Icon nom="recharger" /></button>
  {/if}
  <button
    class="compact"
    aria-label={win.compact ? "Quitter le mode compact" : "Mode compact"}
    title={win.compact ? "Quitter le mode compact (⌘⇧S)" : "Mode compact (⌘⇧S)"}
    aria-pressed={win.compact}
    onclick={() => api.agir({ type: "basculerCompact", fenetreId: win.id })}><Icon nom="barre" /></button>
  <DesignButton />
</div>
<div class="ligne">
<form onsubmit={validate}>
  <input
    bind:this={champ}
    data-testid="barre-adresse"
    class:avec-acces={droitsAgent}
    value={input ?? (tab ? hostName(tab.url) : "")}
    placeholder="Rechercher ou saisir une adresse"
    spellcheck="false"
    oninput={(e) => {
      input = e.currentTarget.value;
      void suggest(input);
    }}
    onfocus={(e) => {
      input = tab?.url ?? "";
      const el = e.currentTarget;
      requestAnimationFrame(() => el.select());
    }}
    onblur={() => {
      input = null;
      closeSuggestions();
    }}
    onkeydown={clavier}
    role="combobox"
    aria-expanded={suggestions.length > 0}
    aria-controls="suggestions"
    aria-autocomplete="list"
  />
  {#if tab && droitsAgent}<span class="acces"><AccessBadge id={tab.id} etat={droitsAgent} /></span>{/if}
  {#if suggestions.length}
    <ul class="suggestions" id="suggestions" role="listbox">
      {#each suggestions as v, i (v.url)}
        <li
          data-testid="suggestion"
          role="option"
          aria-selected={i === chosen}
          onmousedown={(e) => {
            e.preventDefault();
            aller(v.url);
          }}
        >
          <span class="titre">{v.titre}</span>
          <span class="url">{v.url}</span>
        </li>
      {/each}
    </ul>
  {/if}
</form>
<ExtensionsBar fenetre={win} />
</div>

<style>
  .navigation { display: flex; gap: 2px; padding: 0 2px 6px 70px; -webkit-app-region: drag; }
  .navigation button { all: unset; width: 26px; height: 24px; display: grid; place-content: center; border-radius: 5px; color: var(--texte-doux); -webkit-app-region: no-drag; }
  .navigation button:hover:not(:disabled) { background: var(--fond-survol); color: var(--texte); }
  .navigation button:disabled { opacity: 0.35; }
  .navigation .compact { margin-left: auto; }
  .navigation .compact[aria-pressed="true"] { color: var(--accent); }
  /* The badge: a background under its first row (field and extensions), the extensions panel wraps to the line below. */
  .ligne { position: relative; z-index: 1; display: flex; align-items: center; flex-wrap: wrap; -webkit-app-region: no-drag; }
  .ligne::before { content: ""; position: absolute; z-index: -1; inset: 0 0 auto; height: 34px; box-sizing: border-box; border-radius: 10px; border: 1px solid transparent; background: var(--fond-survol); }
  .ligne:has(input:focus)::before { border-color: var(--accent); background: var(--fond); }
  .ligne :global(.extensions) { padding-right: 3px; }
  form { position: relative; flex: 1; min-width: 80px; height: 34px; }
  .acces { position: absolute; right: 6px; top: 50%; transform: translateY(-50%); }
  .suggestions { position: absolute; left: 0; right: 0; top: calc(100% + 4px); z-index: 5; list-style: none; margin: 0; padding: 4px; background: var(--fond-actif); border: 1px solid var(--bord); border-radius: 8px; box-shadow: 0 6px 20px rgba(0, 0, 0, 0.35); }
  .suggestions li { display: flex; flex-direction: column; padding: 5px 8px; border-radius: 5px; color: var(--texte); }
  .suggestions li[aria-selected="true"], .suggestions li:hover { background: var(--fond-survol); }
  .suggestions span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .suggestions .url { font-size: 11px; color: var(--texte-doux); }
  input { width: 100%; height: 100%; box-sizing: border-box; padding: 0 10px; border: none; background: none; color: var(--texte); outline: none; -webkit-app-region: no-drag; }
  input.avec-acces { padding-right: 56px; }
</style>
