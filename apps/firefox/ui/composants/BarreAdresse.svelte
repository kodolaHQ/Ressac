<script lang="ts">
  import BarreExtensions from "../ExtensionsStrip.svelte";
  import BoutonDesign from "./BoutonDesign.svelte";
  import PastilleAcces from "./PastilleAcces.svelte";
  import Icone from "./Icone.svelte";
  import type { EtatFenetre, Visite } from "../../shared/modele";
  import { accesDe, api, etat } from "../etat.svelte";

  let { fenetre }: { fenetre: EtatFenetre } = $props();
  const onglet = $derived.by(() => {
    const id = fenetre.actif[fenetre.espaceActif];
    return id ? etat.valeur?.onglets[id] : undefined;
  });
  const droitsAgent = $derived(onglet ? accesDe(onglet.id) : undefined);
  let saisie = $state<string | null>(null); // non nul pendant l'édition
  let champ: HTMLInputElement;
  let suggestions = $state<Visite[]>([]);
  let choisie = $state(-1);
  let requete = 0;

  async function suggerer(texte: string) {
    const n = ++requete;
    const r = texte.trim() ? await api.historique.rechercher(texte.trim(), 6, true) : [];
    if (n === requete && saisie !== null) {
      suggestions = r;
      choisie = -1;
    }
  }

  function fermerSuggestions() {
    requete++;
    suggestions = [];
    choisie = -1;
  }

  function aller(texte: string) {
    api.naviguer(onglet?.id ?? null, texte);
    saisie = null;
    fermerSuggestions();
    champ.blur();
  }

  function clavier(e: KeyboardEvent) {
    if (e.key === "Escape") champ.blur();
    else if (e.key === "ArrowDown" && suggestions.length) {
      e.preventDefault();
      choisie = (choisie + 1) % suggestions.length;
    } else if (e.key === "ArrowUp" && suggestions.length) {
      e.preventDefault();
      choisie = choisie <= 0 ? suggestions.length - 1 : choisie - 1;
    }
  }

  function hote(url: string): string {
    try {
      const u = new URL(url);
      return u.protocol === "http:" || u.protocol === "https:" ? u.hostname.replace(/^www\./, "") : url;
    } catch {
      return url;
    }
  }

  function valider(e: SubmitEvent) {
    e.preventDefault();
    const suggestion = suggestions[choisie];
    const texte = suggestion?.url ?? saisie?.trim();
    if (texte) aller(texte);
    else champ.blur();
  }
</script>

<div class="navigation">
  <button aria-label="Reculer" disabled={!onglet?.peutReculer} onclick={() => onglet && api.commande(onglet.id, "reculer")}><Icone nom="reculer" /></button>
  <button aria-label="Avancer" disabled={!onglet?.peutAvancer} onclick={() => onglet && api.commande(onglet.id, "avancer")}><Icone nom="avancer" /></button>
  {#if onglet?.chargement}
    <button aria-label="Arrêter" onclick={() => api.commande(onglet.id, "arreter")}><Icone nom="fermer" /></button>
  {:else}
    <button aria-label="Recharger" disabled={!onglet} onclick={() => onglet && api.commande(onglet.id, "recharger")}><Icone nom="recharger" /></button>
  {/if}
  <button
    class="compact"
    aria-label={fenetre.compact ? "Quitter le mode compact" : "Mode compact"}
    title={fenetre.compact ? "Quitter le mode compact (⌘⇧S)" : "Mode compact (⌘⇧S)"}
    aria-pressed={fenetre.compact}
    onclick={() => api.agir({ type: "basculerCompact", fenetreId: fenetre.id })}><Icone nom="barre" /></button>
  <BoutonDesign />
</div>
<div class="ligne">
<form onsubmit={valider}>
  <input
    bind:this={champ}
    data-testid="barre-adresse"
    class:avec-acces={droitsAgent}
    value={saisie ?? (onglet ? hote(onglet.url) : "")}
    placeholder="Rechercher ou saisir une adresse"
    spellcheck="false"
    oninput={(e) => {
      saisie = e.currentTarget.value;
      void suggerer(saisie);
    }}
    onfocus={(e) => {
      saisie = onglet?.url ?? "";
      const el = e.currentTarget;
      requestAnimationFrame(() => el.select());
    }}
    onblur={() => {
      saisie = null;
      fermerSuggestions();
    }}
    onkeydown={clavier}
    role="combobox"
    aria-expanded={suggestions.length > 0}
    aria-controls="suggestions"
    aria-autocomplete="list"
  />
  {#if onglet && droitsAgent}<span class="acces"><PastilleAcces id={onglet.id} etat={droitsAgent} /></span>{/if}
  {#if suggestions.length}
    <ul class="suggestions" id="suggestions" role="listbox">
      {#each suggestions as v, i (v.url)}
        <li
          data-testid="suggestion"
          role="option"
          aria-selected={i === choisie}
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
<BarreExtensions {fenetre} />
</div>

<style>
  .navigation { display: flex; gap: 2px; padding: 0 2px 6px 70px; -webkit-app-region: drag; }
  .navigation button { all: unset; width: 26px; height: 24px; display: grid; place-content: center; border-radius: 5px; color: var(--texte-doux); -webkit-app-region: no-drag; }
  .navigation button:hover:not(:disabled) { background: var(--fond-survol); color: var(--texte); }
  .navigation button:disabled { opacity: 0.35; }
  .navigation .compact { margin-left: auto; }
  .navigation .compact[aria-pressed="true"] { color: var(--accent); }
  /* La pastille : un fond sous sa première rangée (champ et extensions), le panneau des extensions passe à la ligne dessous. */
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
