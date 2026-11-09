<script lang="ts">
  import Icon from "./Icon.svelte";
  import { openMenu } from "./menu.svelte";
  import type { WindowState, Visit } from "../../shared/model";
  import { api } from "../state.svelte";

  let { window: win, close: close }: { window: WindowState; close: () => void } = $props();
  let text = $state("");
  let visits = $state<Visit[]>([]);
  let clearChoice = $state(false);
  let field: HTMLInputElement;
  let request = 0;

  async function load() {
    const n = ++request;
    const r = text.trim() ? await api.history.search(text.trim(), 200) : await api.history.recent();
    if (n === request) visits = r;
  }

  $effect(() => {
    void text;
    void load();
  });
  $effect(() => field.focus());

  function day(iso: string): string {
    const d = new Date(iso);
    const today = new Date();
    const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
    if (d.toDateString() === today.toDateString()) return "Aujourd'hui";
    if (d.toDateString() === yesterday.toDateString()) return "Hier";
    return d.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  }

  const groups = $derived.by(() => {
    const g: { day: string; visits: Visit[] }[] = [];
    for (const v of visits) {
      const j = day(v.lastVisit);
      if (g.at(-1)?.day !== j) g.push({ day: j, visits: [] });
      g.at(-1)!.visits.push(v);
    }
    return g;
  });

  async function clear(from?: Date) {
    clearChoice = false;
    await api.history.clear(from?.toISOString());
    await load();
  }

  function open(e: MouseEvent, url: string) {
    e.preventDefault();
    api.dispatch({ type: "openTab", windowId: win.id, url });
    close();
  }

  function visitMenu(e: MouseEvent, v: Visit) {
    if (!v.kept) return;
    openMenu(e, [{ label: "Oublier le texte retenu", dispatch: () => void api.history.forgetText(v.url, v.spaceId).then(load) }], { free: true });
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
    <input bind:this={field} type="search" bind:value={text} placeholder="Rechercher dans l'historique" spellcheck="false" />
    <div class="effacer">
      <button onclick={() => (clearChoice = !clearChoice)}>Effacer l'historique</button>
      {#if clearChoice}
        <div class="choix">
          <button onclick={() => clear(new Date(Date.now() - 3600_000))}>Dernière heure</button>
          <button onclick={() => clear(dayStart())}>Aujourd'hui</button>
          <button onclick={() => clear()}>Tout</button>
        </div>
      {/if}
    </div>
    <button class="fermer" aria-label="Fermer l'historique" onclick={close}><Icon name="close" size={12} /></button>
  </header>
  {#each groups as g (g.day)}
    <h2>{g.day}</h2>
    <ul>
      {#each g.visits as v (`${v.spaceId}|${v.url}`)}
        <li data-prive={v.private ? "true" : undefined} data-retenu={v.kept ? "true" : undefined}>
          <a href={v.url} onclick={(e) => open(e, v.url)} oncontextmenu={(e) => visitMenu(e, v)}>
            <span class="heure">{new Date(v.lastVisit).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}</span>
            {#if v.private}<span class="cadenas" title="Espace privé" aria-label="Espace privé">🔒</span>{/if}
            <span class="titre">{v.title}</span>
            {#if v.kept}<span class="retenu" title="Texte retenu pour l'agent" aria-label="Texte retenu pour l'agent">🧠</span>{/if}
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
