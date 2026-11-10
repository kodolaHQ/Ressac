<script lang="ts">
  import type { Suggestion } from "./suggestions";

  /** The proposed actions, then the usual row (search or address): `choisie` = -1: no choice. */
  let {
    suggestions,
    usualLine: usualLine,
    chosen: chosen,
    choose: choose,
  }: { suggestions: Suggestion[]; usualLine: string; chosen: number; choose: (i: number) => void } = $props();
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
      {s.input ? `${s.name} — ${s.input}` : s.name}
    </li>
  {/each}
  <li
    id="suggestion-action-{suggestions.length}"
    class="usual"
    role="option"
    aria-selected={chosen === suggestions.length}
    data-testid="usual-suggestion"
    onmousedown={(e) => {
      e.preventDefault();
      choose(suggestions.length);
    }}
  >
    {usualLine}
  </li>
</ul>

<style>
  .suggestions-actions { -webkit-app-region: no-drag; list-style: none; margin: 4px 0 0; padding: 4px; border-radius: 10px; border: 1px solid var(--border); background: var(--bg-bar); }
  li { padding: 8px 12px; border-radius: 6px; cursor: pointer; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  li.usual { color: var(--text-muted); }
  li:hover { background: var(--bg-hover); }
  li[aria-selected="true"] { background: var(--bg-active); }
</style>
