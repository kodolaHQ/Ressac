<script lang="ts">
  import { tick } from "svelte";
  import { fade } from "svelte/transition";
  import type { InstructionChange } from "@ressac/kernel";
  import { api } from "../state.svelte";
  import { t } from "../i18n.svelte";
  import { fileName, foldLines, shownPath } from "./instructionReview";

  let {
    id,
    files,
    visible,
    onAnswer = api.agent.review,
  }: { id: number; files: InstructionChange[]; visible: boolean; /** The chat answers its own discussion's card (`chat.review`). */ onAnswer?: (id: number, choice: "keep" | "revert") => Promise<void> } = $props();
  let card = $state<HTMLElement>();
  let revert = $state<HTMLButtonElement>();
  /** The review already answered: its buttons wait for the next review's id. */
  let answered = $state<number>();
  const answer = (choice: "keep" | "revert") => {
    answered = id;
    // A failed request leaves the buttons usable: the host's id check still refuses a stale answer.
    onAnswer(id, choice).catch(() => (answered = undefined));
  };
  /** Detail folded by default: the list says what changed, the diff is for whoever wants it. */
  let detail = $state(false);
  let detailBox = $state<HTMLElement>();
  // In a short panel the detail opens below the fold: it is brought into view.
  const toggleDetail = () => {
    detail = !detail;
    if (detail) void tick().then(() => detailBox?.scrollIntoView({ block: "nearest" }));
  };
  const kindText = { changed: "agent-review-status-modified", created: "agent-review-status-added", deleted: "agent-review-status-deleted" } as const;
  /** One row per named thing and kind: a skill's ten files are one « Compétence « x » · supprimé » row. */
  const rows = $derived.by(() => {
    const byKey = new Map<string, { name: string; status: InstructionChange["status"]; paths: string[] }>();
    for (const f of files) {
      const n = fileName(f.path);
      const name = t(n.id, n.args);
      const key = `${name}\u0000${f.status}`;
      if (!byKey.has(key)) byKey.set(key, { name, status: f.status, paths: [] });
      byKey.get(key)!.paths.push(f.path);
    }
    return [...byKey.values()];
  });
  const markerText: Record<string, string> = { binary: "agent-review-binary", other: "agent-review-other", unreadable: "agent-review-unreadable", "too-many": "agent-review-too-many" };
  // The safe choice takes the keyboard when a review shows in a visible panel.
  $effect(() => {
    void id;
    if (visible) void tick().then(() => revert?.focus());
  });
</script>

<!-- A fade never ends in a hidden panel (no frames): off screen, the card leaves at once. -->
<div class="review" data-testid="agent-review" role="group" aria-labelledby="agent-review-title" bind:this={card} out:fade={{ duration: card?.getClientRects().length ? 150 : 0 }}>
  <!-- Everything but the choices scrolls when the panel is short: the choices always stay in view. -->
  <div class="body">
    <h2 id="agent-review-title">{t("agent-review-title")}</h2>
    <p class="intro">{t("agent-review-intro")}</p>
    <ul class="rows">
      {#each rows as r (r.name + r.status)}
        <li data-testid="agent-review-row">
          <span class="name">{r.name}</span>
          <span class="badge">{t(kindText[r.status])}</span>
          <span class="where">{r.paths.length === 1 ? shownPath(r.paths[0]!) : t("agent-review-files-count", { count: r.paths.length })}</span>
        </li>
      {/each}
    </ul>
    <button class="link" data-testid="agent-review-detail" aria-expanded={detail} aria-controls="agent-review-detail" onclick={toggleDetail}>{t(detail ? "agent-review-detail-hide" : "agent-review-detail-show")}</button>
    {#if detail}
      <div class="detail" id="agent-review-detail" bind:this={detailBox} transition:fade={{ duration: 150 }}>
        {#each files as f (f.path)}
          <div class="file">
            <p class="path">{shownPath(f.path)}<span class="badge">{t(kindText[f.status])}</span></p>
            {#if f.lines === null}
              <p class="too-long">{f.marker?.startsWith("link:") ? t("agent-review-link", { target: f.marker.slice("link:".length) }) : t(markerText[f.marker ?? ""] ?? "agent-review-too-long")}</p>
            {:else}
              <div class="code-diff">
                {#each foldLines(f.lines) as l, i (i)}
                  {#if "folded" in l}
                    <div class="folded">{t("agent-review-folded", { count: l.folded })}</div>
                  {:else}
                    <div class="line" class:added={l.kind === "+"} class:removed={l.kind === "-"}>{l.text}</div>
                  {/if}
                {/each}
              </div>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  </div>
  <div class="actions">
    <div class="choice">
      <button data-testid="agent-review-revert" aria-describedby="agent-review-revert-hint" disabled={answered === id} bind:this={revert} onclick={() => answer("revert")}>{t("agent-review-revert")}</button>
      <p class="hint" id="agent-review-revert-hint">{t("agent-review-revert-hint")}</p>
    </div>
    <div class="choice">
      <button class="secondary" data-testid="agent-review-keep" aria-describedby="agent-review-keep-hint" disabled={answered === id} onclick={() => answer("keep")}>{t("agent-review-keep")}</button>
      <p class="hint" id="agent-review-keep-hint">{t("agent-review-keep-hint")}</p>
    </div>
  </div>
</div>

<style>
  .review { flex: 0 1 auto; min-height: 0; overflow: auto; display: flex; flex-direction: column; margin: 0 6px 6px; padding: 12px 12px 14px; border-radius: 11px; background: var(--glass-hi); box-shadow: inset 0 0 0 1px var(--border); animation: ressac-rise var(--spring-d) var(--spring) backwards; }
  h2 { margin: 0 0 6px; font: 600 14px/1.3 var(--font-display); letter-spacing: -0.01em; }
  .intro { margin: 0 0 12px; color: var(--text-muted); line-height: 1.45; }
  .rows { list-style: none; margin: 0 0 8px; padding: 0; display: flex; flex-direction: column; gap: 6px; }
  .rows li { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 8px; min-width: 0; }
  .name { font-weight: 600; }
  .where { flex-basis: 100%; min-width: 0; color: var(--text-muted); font: 11.5px var(--font-mono); overflow-wrap: anywhere; }
  .badge { padding: 1px 6px; border-radius: 6px; background: var(--bg-hover); color: var(--text-muted); font: 600 11px var(--font-ui); }
  .body { flex: 0 1 auto; min-height: 0; overflow: auto; display: flex; flex-direction: column; }
  /* A long diff (a whole LICENSE) scrolls on its own. */
  .detail { flex: none; max-height: 45vh; overflow: auto; margin-top: 8px; }
  .file { margin-bottom: 12px; }
  .path { display: flex; align-items: center; gap: 6px; margin: 0 0 6px; font: 500 12.5px var(--font-mono); overflow-wrap: anywhere; }
  .too-long { margin: 0; color: var(--text-muted); }
  /* DiffFile's colours, without its numbers and comment margin: the panel is narrow. */
  .code-diff { font: 12px/1.5 var(--font-mono); background: var(--sheet); border: 1px solid var(--border); border-radius: 10px; overflow: auto; }
  .line { white-space: pre; padding: 0 8px 0 18px; position: relative; }
  .line::before { position: absolute; left: 6px; color: var(--text-muted); }
  .added { background: color-mix(in srgb, var(--running) 16%, transparent); }
  .added::before { content: "+"; }
  .removed { background: color-mix(in srgb, var(--in-error) 16%, transparent); }
  .removed::before { content: "−"; }
  .folded { padding: 2px 8px; border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); background: var(--bg-hover); color: var(--text-muted); font: 11px var(--font-ui); }
  .actions { flex: none; display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 0 10px; margin-top: 12px; }
  /* Subgrid: both buttons share a row, so a label on two lines makes them the same height. */
  .choice { display: grid; grid-row: span 2; grid-template-rows: subgrid; row-gap: 4px; }
  .hint { margin: 0; color: var(--text-muted); font-size: 11.5px; line-height: 1.35; }
  button.link { align-self: flex-start; padding: 2px 0; background: transparent; color: var(--accent); font-weight: 500; }
  button { padding: 6px 14px; border-radius: 10px; border: 0; background: var(--accent); color: var(--accent-ink); font: 600 12.5px var(--font-ui); cursor: pointer; transition: transform var(--tap); }
  button.secondary { background: var(--sheet); color: var(--text); box-shadow: inset 0 0 0 1px var(--border); }
  button:active:not(:disabled) { transform: scale(0.97); }
  button:disabled { opacity: 0.6; cursor: default; }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
</style>
