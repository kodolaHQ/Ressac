<script lang="ts">
  import Icon from "./Icone.svelte";
  import { openMenu } from "./menu.svelte";
  import type { WindowState, Visite } from "../../shared/modele";
  import { api } from "../etat.svelte";

  let { fenetre: win, fermer: close }: { fenetre: WindowState; fermer: () => void } = $props();
  let text = $state("");
  let visites = $state<Visite[]>([]);
  let clearChoice = $state(false);
  let champ: HTMLInputElement;
  let request = 0;

  async function charger() {
    const n = ++request;
    const r = text.trim() ? await api.historique.rechercher(text.trim(), 200) : await api.historique.recents();
    if (n === request) visites = r;
  }

  $effect(() => {
    void text;
    void charger();
  });
  $effect(() => champ.focus());

  function day(iso: string): string {
    const d = new Date(iso);
    const today = new Date();
    const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
    if (d.toDateString() === today.toDateString()) return "Aujourd'hui";
    if (d.toDateString() === yesterday.toDateString()) return "Hier";
    return d.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  }

  const groups = $derived.by(() => {
    const g: { jour: string; visites: Visite[] }[] = [];
    for (const v of visites) {
      const j = day(v.derniereVisite);
      if (g.at(-1)?.jour !== j) g.push({ jour: j, visites: [] });
      g.at(-1)!.visites.push(v);
    }
    return g;
  });

  async function effacer(from?: Date) {
    clearChoice = false;
    await api.historique.effacer(from?.toISOString());
    await charger();
  }

  function open(e: MouseEvent, url: string) {
    e.preventDefault();
    api.agir({ type: "ouvrirOnglet", fenetreId: win.id, url });
    close();
  }

  function menuVisite(e: MouseEvent, v: Visite) {
    if (!v.retenu) return;
    openMenu(e, [{ libelle: "Oublier le texte retenu", agir: () => void api.historique.oublierTexte(v.url, v.espaceId).then(charger) }], { libre: true });
  }

    const dayStart = () => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  };
</script>

<svelte:window onkeydown={(e) => e.key === "Escape" && close()} />

<section class="historique" data-testid="historique" aria-label="Historique">
  <header>
    <h1>Historique</h1>
    <input bind:this={champ} type="search" bind:value={text} placeholder="Rechercher dans l'historique" spellcheck="false" />
    <div class="effacer">
      <button onclick={() => (clearChoice = !clearChoice)}>Effacer l'historique</button>
      {#if clearChoice}
        <div class="choix">
          <button onclick={() => effacer(new Date(Date.now() - 3600_000))}>Dernière heure</button>
          <button onclick={() => effacer(dayStart())}>Aujourd'hui</button>
          <button onclick={() => effacer()}>Tout</button>
        </div>
      {/if}
    </div>
    <button class="fermer" aria-label="Fermer l'historique" onclick={close}><Icon nom="fermer" taille={12} /></button>
  </header>
  {#each groups as g (g.jour)}
    <h2>{g.jour}</h2>
    <ul>
      {#each g.visites as v (`${v.espaceId}|${v.url}`)}
        <li data-prive={v.prive ? "true" : undefined} data-retenu={v.retenu ? "true" : undefined}>
          <a href={v.url} onclick={(e) => open(e, v.url)} oncontextmenu={(e) => menuVisite(e, v)}>
            <span class="heure">{new Date(v.derniereVisite).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}</span>
            {#if v.prive}<span class="cadenas" title="Espace privé" aria-label="Espace privé">🔒</span>{/if}
            <span class="titre">{v.titre}</span>
            {#if v.retenu}<span class="retenu" title="Texte retenu pour l'agent" aria-label="Texte retenu pour l'agent">🧠</span>{/if}
            <span class="url">{v.url}</span>
          </a>
        </li>
      {/each}
    </ul>
  {:else}
    <p class="vide">{text ? "Aucun résultat." : "L'historique est vide."}</p>
  {/each}
</section>

<style>
  .historique { height: 100%; overflow-y: auto; box-sizing: border-box; padding: 24px 32px; color: var(--texte); }
  header { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
  h1 { font-size: 18px; margin: 0; }
  header input { flex: 1; padding: 8px 12px; border-radius: 8px; border: 1px solid var(--bord); background: var(--fond-barre); color: var(--texte); outline: none; }
  header button { padding: 6px 10px; border-radius: 6px; border: 1px solid var(--bord); background: var(--fond-barre); color: var(--texte); }
  .fermer { border: none; background: none; }
  .effacer { position: relative; }
  .choix { position: absolute; right: 0; top: 110%; display: flex; flex-direction: column; gap: 2px; padding: 4px; background: var(--fond-actif); border-radius: 6px; z-index: 1; }
  h2 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--texte-doux); margin: 20px 0 6px; }
  ul { list-style: none; margin: 0; padding: 0; }
  a { display: flex; gap: 12px; padding: 6px 8px; border-radius: 6px; color: inherit; text-decoration: none; }
  a:hover { background: var(--fond-survol); }
  .heure { color: var(--texte-doux); font-variant-numeric: tabular-nums; }
  .retenu { font-size: 11px; opacity: 0.7; }
  .titre { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .url { margin-left: auto; color: var(--texte-doux); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 40%; }
  .vide { color: var(--texte-doux); }
</style>
