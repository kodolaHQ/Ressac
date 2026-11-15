<script lang="ts">
  import type { Suggestion } from "./suggestions";

  /** The proposed actions, then the usual row (search or address): `choisie` = -1: no choice. */
  let {
    suggestions,
    usualLine,
    chosen,
    choose,
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
  .suggestions-actions { -webkit-app-region: no-drag; list-style: none; margin: 6px 0 0; padding: 6px; border-radius: 16px; border: 1px solid var(--glass-edge); background: var(--glass); backdrop-filter: blur(30px) saturate(1.8); box-shadow: var(--modal-shadow); animation: ressac-drop var(--spring-d) var(--spring) backwards; }
  li { padding: 9px 12px; border-radius: 10px; cursor: pointer; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; transition: background var(--tap); }
  li.usual { color: var(--text-muted); }
  li:hover { background: color-mix(in srgb, var(--glass-hi) 55%, transparent); }
  li[aria-selected="true"] { background: var(--glass-hi); box-shadow: inset 0 0 0 1px var(--glass-edge); }
</style>
