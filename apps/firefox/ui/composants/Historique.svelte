<script lang="ts">
  import Icone from "./Icone.svelte";
  import { ouvrirMenu } from "./menu.svelte";
  import type { WindowState, Visite } from "../../shared/modele";
  import { api } from "../etat.svelte";

  let { fenetre, fermer }: { fenetre: WindowState; fermer: () => void } = $props();
  let texte = $state("");
  let visites = $state<Visite[]>([]);
  let choixEffacer = $state(false);
  let champ: HTMLInputElement;
  let requete = 0;

  async function charger() {
    const n = ++requete;
    const r = texte.trim() ? await api.historique.rechercher(texte.trim(), 200) : await api.historique.recents();
    if (n === requete) visites = r;
  }

  $effect(() => {
    void texte;
    void charger();
  });
  $effect(() => champ.focus());

  function jour(iso: string): string {
    const d = new Date(iso);
    const aujourdhui = new Date();
    const hier = new Date(aujourdhui.getFullYear(), aujourdhui.getMonth(), aujourdhui.getDate() - 1);
    if (d.toDateString() === aujourdhui.toDateString()) return "Aujourd'hui";
    if (d.toDateString() === hier.toDateString()) return "Hier";
    return d.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  }

  const groupes = $derived.by(() => {
    const g: { jour: string; visites: Visite[] }[] = [];
    for (const v of visites) {
      const j = jour(v.derniereVisite);
      if (g.at(-1)?.jour !== j) g.push({ jour: j, visites: [] });
      g.at(-1)!.visites.push(v);
    }
    return g;
  });

  async function effacer(depuis?: Date) {
    choixEffacer = false;
    await api.historique.effacer(depuis?.toISOString());
    await charger();
  }

  function ouvrir(e: MouseEvent, url: string) {
    e.preventDefault();
    api.agir({ type: "ouvrirOnglet", fenetreId: fenetre.id, url });
    fermer();
  }

  function menuVisite(e: MouseEvent, v: Visite) {
    if (!v.retenu) return;
    ouvrirMenu(e, [{ libelle: "Oublier le texte retenu", agir: () => void api.historique.oublierTexte(v.url, v.espaceId).then(charger) }], { libre: true });
  }

    const debutDuJour = () => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  };
</script>

<svelte:window onkeydown={(e) => e.key === "Escape" && fermer()} />

<section class="historique" data-testid="historique" aria-label="Historique">
  <header>
    <h1>Historique</h1>
    <input bind:this={champ} type="search" bind:value={texte} placeholder="Rechercher dans l'historique" spellcheck="false" />
    <div class="effacer">
      <button onclick={() => (choixEffacer = !choixEffacer)}>Effacer l'historique</button>
      {#if choixEffacer}
        <div class="choix">
          <button onclick={() => effacer(new Date(Date.now() - 3600_000))}>Dernière heure</button>
          <button onclick={() => effacer(debutDuJour())}>Aujourd'hui</button>
          <button onclick={() => effacer()}>Tout</button>
        </div>
      {/if}
    </div>
    <button class="fermer" aria-label="Fermer l'historique" onclick={fermer}><Icone nom="fermer" taille={12} /></button>
  </header>
  {#each groupes as g (g.jour)}
    <h2>{g.jour}</h2>
    <ul>
      {#each g.visites as v (`${v.espaceId}|${v.url}`)}
        <li data-prive={v.prive ? "true" : undefined} data-retenu={v.retenu ? "true" : undefined}>
          <a href={v.url} onclick={(e) => ouvrir(e, v.url)} oncontextmenu={(e) => menuVisite(e, v)}>
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
    <p class="vide">{texte ? "Aucun résultat." : "L'historique est vide."}</p>
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
