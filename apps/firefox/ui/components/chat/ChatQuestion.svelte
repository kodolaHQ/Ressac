<script lang="ts">
  import { untrack } from "svelte";
  import type { ChatItem } from "../../../shared/chat";
  import { api } from "../../state.svelte";
  import { t } from "../../i18n.svelte";

  /** The agent's question (AskUserQuestion): one button per option, checkboxes and « Valider » when several answers or questions. */
  let { item }: { item: Extract<ChatItem, { kind: "question" }> } = $props();
  /** Chosen labels per question text. */
  let picks = $state<Record<string, string[]>>({});
  /** Answered here: the buttons go at once, before the host's view comes back. */
  let sent = $state(false);
  // Each view the host pushes is a new item: a card still unanswered there takes presses again (an answer lost on the way).
  $effect(() => {
    void item;
    untrack(() => (sent = false));
  });
  const oneClick = $derived(item.questions.length === 1 && !item.questions[0]!.multiSelect);
  const complete = $derived(item.questions.every((q) => picks[q.question]?.length));

  function send(answers: Record<string, string>) {
    sent = true;
    api.chat.answer(item.id, { answers });
  }
  function pick(question: string, label: string, multi: boolean) {
    if (oneClick) return send({ [question]: label });
    const now = picks[question] ?? [];
    picks[question] = multi ? (now.includes(label) ? now.filter((l) => l !== label) : [...now, label]) : [label];
  }
  const validate = () => send(Object.fromEntries(item.questions.map((q) => [q.question, (picks[q.question] ?? []).join(", ")])));
</script>

{#if item.answer !== undefined}
  <p class="answered" data-testid="chat-question-answered">
    {#if item.answer === "cancelled"}
      {t("chat-question-ignored")}
    {:else}
      {#each item.questions as q (q.question)}<span><strong>{q.header || q.question}</strong> : {item.answer[q.question] ?? ""}</span>{/each}
    {/if}
  </p>
{:else}
  <section class="card" aria-label={t("chat-question")} data-testid="chat-question">
    {#each item.questions as q, qi (q.question)}
      <div class="q">
        {#if q.header}<strong>{q.header}</strong>{/if}
        <p>{q.question}</p>
        {#if q.multiSelect}
          <div class="checks">
            {#each q.options as o (o.label)}
              <label title={o.description}>
                <input type="checkbox" disabled={sent} checked={picks[q.question]?.includes(o.label) ?? false} onchange={() => pick(q.question, o.label, true)} />{o.label}
              </label>
            {/each}
          </div>
        {:else}
          <div class="options" role={oneClick ? undefined : "radiogroup"} aria-label={oneClick ? undefined : q.question}>
            {#each q.options as o, oi (o.label)}
              <button
                class:primary={oneClick ? qi === 0 && oi === 0 : picks[q.question]?.[0] === o.label}
                role={oneClick ? undefined : "radio"}
                aria-checked={oneClick ? undefined : picks[q.question]?.[0] === o.label}
                title={o.description}
                disabled={sent}
                data-testid="chat-question-option"
                onclick={() => pick(q.question, o.label, false)}>{o.label}</button
              >
            {/each}
          </div>
        {/if}
      </div>
    {/each}
    {#if !oneClick}
      <button class="primary validate" data-testid="chat-question-validate" disabled={sent || !complete} onclick={validate}>{t("chat-question-validate")}</button>
    {/if}
  </section>
{/if}

<style>
  .card { display: flex; flex-direction: column; gap: 10px; padding: 12px 14px; border-radius: 16px; border: 1px solid var(--glass-edge); background: var(--bg-hover); animation: ressac-rise var(--spring-d) var(--spring) backwards; }
  .q { display: flex; flex-direction: column; gap: 6px; }
  strong { font-size: 13px; }
  p { margin: 0; color: var(--text-muted); font-size: 12.5px; }
  .options { display: flex; flex-wrap: wrap; gap: 6px; }
  .checks { display: flex; flex-direction: column; gap: 4px; font-size: 12.5px; }
  .checks label { display: flex; align-items: center; gap: 6px; }
  button { padding: 6px 12px; border-radius: 10px; border: 1px solid var(--border); background: var(--glass-hi); color: var(--text); font: 600 12.5px var(--font-ui); cursor: pointer; transition: transform var(--tap); }
  button.primary { border-color: var(--accent); background: var(--accent); color: var(--accent-ink); }
  button:active:not(:disabled) { transform: scale(0.97); }
  button:disabled { opacity: 0.6; cursor: default; }
  button:focus-visible, input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .validate { align-self: flex-start; }
  .answered { display: flex; flex-direction: column; gap: 2px; margin: 0; padding: 6px 10px; border-radius: 10px; background: var(--bg-hover); color: var(--text-muted); font-size: 12.5px; animation: ressac-rise var(--spring-d) var(--spring) backwards; }
  .answered strong { color: var(--text); font-size: 12.5px; }
</style>
