<script lang="ts">
  import type { WindowState } from "../../shared/model";
  import { onMount, untrack } from "svelte";
  import { focusEmptyPage } from "./command.svelte";
  import { api, appState } from "../state.svelte";
  import Home from "../Home.svelte";
  import TipCard from "./TipCard.svelte";
  import SuggestionsActions from "./ActionSuggestions.svelte";
  import { suggestionsActions } from "./suggestions";
  import type { ActionShown } from "../../shared/actions";

  let { window: win }: { window: WindowState } = $props();
  let input = $state("");
  let field: HTMLInputElement;

  onMount(() => field.focus());
  // The command bar closed onto home gives the keyboard back to it.
  $effect(() => {
    if (focusEmptyPage.n > 0) untrack(() => field?.focus());
  });

  // Actions are not available in a private space (a missing space counts as private): the list is then not even
  // requested.
  const inPrivate = $derived(appState.value?.spaces.find((e) => e.id === win.activeSpace)?.private ?? true);
  let actions = $state.raw<ActionShown[]>([]);
  let last = 0;
  $effect(() => {
    if (inPrivate) {
      actions = [];
      return;
    }
    const load = () => {
      const n = ++last;
      api.actions.list().then(
        (l) => {
          if (n === last) actions = l;
        },
        () => {},
      );
    };
    load();
    return api.actions.onChange(load);
  });

  // Escape closes the list until the next keystroke.
  let closed = $state(false);
  let chosen = $state(-1);
  const suggestions = $derived(inPrivate || closed ? [] : suggestionsActions(input, actions));
  const usualLine = $derived(/^\S+\.\S+$/.test(input.trim()) ? `Ouvrir ${input.trim()}` : `Rechercher « ${input.trim()} »`);

  let denial = $state("");
  const keys = $derived(suggestions.map((x) => x.id).join("\0"));
  $effect(() => {
    void keys;
    chosen = -1;
  });
  function validate(i: number) {
    const s = suggestions[i];
    if (s) {
      chosen = -1;
      void api.actions.open(s.id, s.input).then(
        (r) => {
          if (r.ok) {
            input = "";
            denial = "";
          } else denial = r.error;
        },
        () => (denial = "Le service des actions ne répond pas"),
      );
    } else if (input.trim()) {
      api.navigate(null, input.trim());
      input = "";
    }
  }
  function key(e: KeyboardEvent) {
    if (suggestions.length === 0) return;
    const n = suggestions.length + 1;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      chosen = (chosen + 1) % n;
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      chosen = chosen < 0 ? n - 1 : chosen - 1;
    } else if (e.key === "Escape") {
      e.preventDefault();
      closed = true;
      chosen = -1;
    }
  }
</script>

<div class="empty-page" data-testid="empty-page">
  <form
    onsubmit={(e) => {
      e.preventDefault();
      validate(chosen);
      chosen = -1;
    }}
  >
    <input
      bind:this={field}
      bind:value={input}
      oninput={() => {
        closed = false;
        denial = "";
        chosen = -1;
      }}
      onblur={() => (closed = true)}
      onfocus={() => (closed = false)}
      onkeydown={key}
      data-testid="empty-page-input"
      placeholder="Rechercher ou saisir une adresse"
      spellcheck="false"
      role={suggestions.length ? "combobox" : undefined}
      aria-expanded={suggestions.length ? true : undefined}
      aria-controls={suggestions.length ? "suggestions-actions" : undefined}
      aria-activedescendant={suggestions.length && chosen >= 0 ? `suggestion-action-${chosen}` : undefined}
    />
    {#if suggestions.length}
      <SuggestionsActions {suggestions} usualLine={usualLine} chosen={chosen} choose={(i) => validate(i)} />
    {/if}
    {#if denial}<p class="refusal" data-testid="action-refusal">{denial}</p>{/if}
  </form>
  <TipCard />
  <Home />
</div>

<style>
  .empty-page { position: relative; display: flex; flex-direction: column; align-items: center; gap: 20px; padding-top: clamp(24px, 6vh, 72px); height: 100%; box-sizing: border-box; overflow-y: auto; }
  form { width: min(560px, 80%); }
  input { width: 100%; box-sizing: border-box; padding: 12px 16px; font-size: 16px; border-radius: 16px; border: 1px solid var(--glass-edge); background: var(--glass); box-shadow: var(--float); color: var(--text); outline: none; transition: border-color var(--tap), box-shadow var(--tap); }
  .refusal { margin: 6px 4px 0; color: var(--in-error); font-size: 13px; }
  input::placeholder { color: var(--text-muted); }
  input:focus { border-color: var(--accent); box-shadow: var(--float), 0 0 0 4px color-mix(in oklab, var(--accent) 18%, transparent); }
  .empty-page :global([data-testid="tip-card"]) { width: min(560px, 80%); box-sizing: border-box; }
</style>
