<script lang="ts">
  import type { Suggestion } from "./suggestions";

  /** The proposed actions, then the usual row (search or address): `choisie` = -1: no choice. */
  let {
    suggestions,
    ligneHabituelle: usualLine,
    choisie: chosen,
    choisir: choose,
  }: { suggestions: Suggestion[]; ligneHabituelle: string; choisie: number; choisir: (i: number) => void } = $props();
</script>

<ul class="suggestions-actions" id="suggestions-actions" role="listbox" data-testid="suggestions-actions">
  {#each suggestions as s, i (s.id)}
    <li
      id="suggestion-action-{i}"
      role="option"
      aria-selected={i === chosen}
      data-testid="suggestion-action"
      onmousedown={(e) => {
        e.preventDefault();
        choose(i);
      }}
    >
      {s.saisie ? `${s.nom} — ${s.saisie}` : s.nom}
    </li>
  {/each}
  <li
    id="suggestion-action-{suggestions.length}"
    class="habituelle"
    role="option"
    aria-selected={chosen === suggestions.length}
    data-testid="suggestion-habituelle"
    onmousedown={(e) => {
      e.preventDefault();
      choose(suggestions.length);
    }}
  >
    {usualLine}
  </li>
</ul>

<style>
  .suggestions-actions { -webkit-app-region: no-drag; list-style: none; margin: 4px 0 0; padding: 4px; border-radius: 10px; border: 1px solid var(--bord); background: var(--fond-barre); }
  li { padding: 8px 12px; border-radius: 6px; cursor: pointer; color: var(--texte); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  li.habituelle { color: var(--texte-doux); }
  li:hover { background: var(--fond-survol); }
  li[aria-selected="true"] { background: var(--fond-actif); }
</style>
