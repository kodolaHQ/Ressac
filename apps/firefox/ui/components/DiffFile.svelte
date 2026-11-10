<script lang="ts">
  import type { DiffComment, DiffFile } from "../../shared/api";
  import { EXPANDED_LINES, NOT_DISPLAYABLE, RANGE_OUTSIDE_BLOCK } from "../../shared/model";
  import { api } from "../state.svelte";
  import ReviewComment from "./ReviewComment.svelte";

  /**
   * A file's unified diff; the lines hidden between hunks unfold by 20. The code stays read-only: the margin's `+`
   * opens a comment on a hunk line (Shift+click or drag extend the range, within the hunk).
   */
  let {
    project: project,
    token: token,
    diff,
    comments: comments,
    onChange: onChange,
  }: { project: string; token: string; diff: DiffFile; comments: DiffComment[]; onChange: () => void } = $props();

  type Block = DiffFile["blocks"][number];
  /** Position of a hunk line: its new number, the next line's for a removal (like the kernel). */
  function position(b: Block, i: number): number {
    for (let k = i; k < b.lines.length; k++) {
      const n = b.lines[k]!.new;
      if (n !== null) return n;
    }
    return b.newStart + b.newCount;
  }

  /** The range in progress: its hunk, the anchor line and the other end (indices in the hunk). */
  let selection = $state<{ block: number; anchor: number; end: number } | null>(null);
  let dragged = $state(false);
  let text = $state("");
  let error = $state<string | null>(null);
  let sending = $state(false);

  const range = $derived.by(() => {
    if (!selection) return null;
    const b = diff.blocks[selection.block]!;
    const p1 = position(b, selection.anchor);
    const p2 = position(b, selection.end);
    const start = Math.min(p1, p2);
    const end = Math.max(p1, p2);
    let last = -1;
    b.lines.forEach((_, k) => {
      const p = position(b, k);
      if (p >= start && p <= end) last = k;
    });
    return { block: selection.block, start: start, end: end, last: last };
  });
  const chosen = (block: number, k: number) => {
    if (!range || range.block !== block) return false;
    const p = position(diff.blocks[block]!, k);
    return p >= range.start && p <= range.end;
  };

  /** `+` pressed: a new range, or (Shift) the other end of the current range, refused outside its hunk. */
  function aim(block: number, k: number, expand: boolean) {
    error = null;
    if (expand && selection) {
      if (selection.block !== block) {
        error = RANGE_OUTSIDE_BLOCK;
        selection = { ...selection, end: selection.anchor };
        return;
      }
      selection = { ...selection, end: k };
      return;
    }
    if (!selection) text = "";
    selection = { block: block, anchor: k, end: k };
    dragged = true;
  }
  /** While dragging: the range follows the mouse, within the hunk only. */
  function hover(block: number, k: number) {
    if (dragged && selection && selection.block === block) selection = { ...selection, end: k };
  }
  function close() {
    selection = null;
    text = "";
    error = null;
  }
  async function validate() {
    if (!range || sending) return;
    sending = true;
    try {
      const r = await api.review.comment(project, token, { file: diff.path, start: range.start, end: range.end, text: text });
      if (r.ok) {
        close();
        onChange();
      } else error = r.error;
    } catch {
      error = "Le commentaire n'a pas pu être enregistré.";
    } finally {
      sending = false;
    }
  }
  function key(e: KeyboardEvent) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void validate();
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  }

  /** Each comment under the last shown line of its range (first hunk that has the line `fin`); otherwise at the top. */
  const places = $derived.by(() => {
    const sub = new Map<string, DiffComment[]>();
    const elsewhere: DiffComment[] = [];
    for (const c of comments) {
      let where: string | null = null;
      for (let i = 0; i < diff.blocks.length && where === null; i++) {
        const b = diff.blocks[i]!;
        for (let k = b.lines.length - 1; k >= 0; k--) {
          if (position(b, k) === c.end) {
            where = `${i}:${k}`;
            break;
          }
        }
      }
      if (where === null) elsewhere.push(c);
      else sub.set(where, [...(sub.get(where) ?? []), c]);
    }
    return { under: sub, elsewhere: elsewhere };
  });

  type Line = { mark: " " | "+" | "-"; text: string; old: number | null; new: number | null };
  /** Unfolded lines of each gap (before hunk i; i = number of hunks: after the last one). */
  type Interval = { lines: Line[]; done: boolean };
  let intervals = $state<Record<number, Interval>>({});
  let onLoaded = $state<number | null>(null);

  const blockStart = (b: DiffFile["blocks"][number]) => (b.newCount === 0 ? b.newStart + 1 : b.newStart);
  const blockEnd = (b: DiffFile["blocks"][number]) => (b.newCount === 0 ? b.newStart + 1 : b.newStart + b.newCount);

  /** The hidden gap before hunk i: first new lines, last one (null: to the end of the file), old − new offset. */
  function cache(i: number): { start: number; end: number | null; offset: number } | null {
    const blocks = diff.blocks;
    if (diff.status === "deleted" || blocks.length === 0) return null;
    if (i === blocks.length) {
      if (diff.status === "added") return null;
      const d = blocks[i - 1]!;
      return { start: blockEnd(d), end: null, offset: d.oldStart + d.oldCount - (d.newStart + d.newCount) };
    }
    const b = blocks[i]!;
    const start = i === 0 ? 1 : blockEnd(blocks[i - 1]!);
    return { start: start, end: blockStart(b) - 1, offset: b.oldStart - b.newStart };
  }

  function remaining(i: number): { start: number; end: number | null; offset: number } | null {
    const c = cache(i);
    if (!c) return null;
    const already = intervals[i];
    if (already?.done) return null;
    const start = c.start + (already?.lines.length ?? 0);
    if (c.end !== null && start > c.end) return null;
    return { ...c, start: start };
  }

  async function expand(i: number) {
    const r = remaining(i);
    if (!r || onLoaded !== null) return;
    onLoaded = i;
    try {
      const end = r.end === null ? r.start + EXPANDED_LINES - 1 : Math.min(r.end, r.start + EXPANDED_LINES - 1);
      const texts = await api.review.lines(project, token, diff.path, r.start, end);
      const already = intervals[i]?.lines ?? [];
      const fresh = texts.map((text, k) => ({ mark: " " as const, text: text, new: r.start + k, old: r.start + k + r.offset }));
      const all = [...already, ...fresh];
      const finished = texts.length < end - r.start + 1 || (r.end !== null && r.start + texts.length > r.end);
      intervals = { ...intervals, [i]: { lines: all, done: finished } };
    } catch {
      intervals = { ...intervals, [i]: { lines: intervals[i]?.lines ?? [], done: true } };
    } finally {
      onLoaded = null;
    }
  }

  const cls = (l: Line) => (l.mark === "+" ? "added" : l.mark === "-" ? "removed" : "context");
</script>

{#snippet row(l: Line)}
  <div class="line {cls(l)}" data-testid="diff-line" data-old={l.old ?? ""} data-new={l.new ?? ""}><span class="margin"></span><span class="num">{l.old ?? ""}</span><span class="num">{l.new ?? ""}</span><span class="code">{l.text}</span></div>
{/snippet}

{#snippet blockRow(l: Line, block: number, k: number)}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="line {cls(l)}"
    class:selected={chosen(block, k)}
    data-testid="diff-line"
    data-old={l.old ?? ""}
    data-new={l.new ?? ""}
    onmouseenter={() => hover(block, k)}
  ><span class="margin"><button
        class="add-button"
        data-testid="add-comment"
        aria-label="Commenter la ligne {position(diff.blocks[block]!, k)}"
        title="Commenter (Maj+clic ou glisser : plusieurs lignes)"
        onmousedown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          aim(block, k, e.shiftKey);
        }}
        onclick={(e) => {
          // Keyboard (Enter, Space): no mousedown.
          if (e.detail === 0) aim(block, k, e.shiftKey);
        }}></button
      ></span><span class="num">{l.old ?? ""}</span><span class="num">{l.new ?? ""}</span><span class="code">{l.text}</span></div>
  {#each places.under.get(`${block}:${k}`) ?? [] as c (c.id)}<ReviewComment project={project} comment={c} onChange={onChange} />{/each}
  {#if range && range.block === block && range.last === k}
    <form class="form" data-testid="comment-form" onsubmit={(e) => { e.preventDefault(); void validate(); }}>
      <div class="range">{range.start === range.end ? `Ligne ${range.start}` : `Lignes ${range.start}–${range.end}`}</div>
      <!-- svelte-ignore a11y_autofocus -->
      <textarea bind:value={text} rows="3" autofocus placeholder="DiffComment (texte simple, Markdown montré tel quel)" onkeydown={key}></textarea>
      {#if error}<p class="error" data-testid="comment-error">{error}</p>{/if}
      <div class="actions">
        <button type="button" onclick={close}>Annuler</button>
        <button type="submit" disabled={sending || text.trim() === ""}>Commenter</button>
      </div>
    </form>
  {/if}
{/snippet}

{#snippet interval(i: number)}
  {#each intervals[i]?.lines ?? [] as l (l.new)}{@render row(l)}{/each}
  {#if remaining(i)}
    <button class="expand" data-testid="expand-context" disabled={onLoaded !== null} onclick={() => void expand(i)}>Afficher les lignes cachées</button>
  {/if}
{/snippet}

<svelte:window onmouseup={() => (dragged = false)} />

<section class="diff" data-testid="diff-file" aria-label="Diff de {diff.path}">
  <h3 class="path">{diff.path}</h3>
  {#each places.elsewhere as c (c.id)}<ReviewComment project={project} comment={c} onChange={onChange} />{/each}
  {#if diff.displayable !== true}
    <p class="not-displayable">{NOT_DISPLAYABLE[diff.displayable]}</p>
  {:else if diff.blocks.length === 0}
    <p class="not-displayable">Aucune ligne modifiée.</p>
  {:else}
    <div class="code-diff">
      {#each diff.blocks as b, i (i)}
        {@render interval(i)}
        {#each b.lines as l, k (k)}{@render blockRow(l, i, k)}{/each}
      {/each}
      {@render interval(diff.blocks.length)}
    </div>
  {/if}
</section>

<style>
  .diff { min-width: 0; }
  .path { margin: 0 0 8px; font-size: 13px; font-weight: 600; overflow-wrap: anywhere; }
  .not-displayable { color: var(--text-muted); }
  .code-diff { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 12px; line-height: 1.5; border: 1px solid var(--border); border-radius: 6px; overflow: auto; }
  .line { display: grid; grid-template-columns: 18px 44px 44px 1fr; }
  .line.selected { box-shadow: inset 3px 0 0 var(--accent, #3b82f6); background: color-mix(in srgb, var(--accent, #3b82f6) 14%, transparent); }
  .margin { display: flex; align-items: center; justify-content: center; }
  .add-button { width: 16px; height: 16px; padding: 0; border: none; border-radius: 4px; background: var(--accent, #3b82f6); color: white; font-size: 12px; line-height: 16px; cursor: pointer; opacity: 0; }
  /* The « + » through CSS: it does not enter the line's text. */
  .add-button::before { content: "+"; }
  .line:hover .add-button, .add-button:focus-visible { opacity: 1; }
  .form { margin: 4px 8px 8px 106px; padding: 8px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); font-family: system-ui, sans-serif; display: flex; flex-direction: column; gap: 6px; }
  .form textarea { font: inherit; font-size: 12px; resize: vertical; padding: 6px; border: 1px solid var(--border); border-radius: 4px; background: var(--bg-bar); color: var(--text); }
  .range { font-size: 11px; color: var(--text-muted); }
  .error { margin: 0; color: var(--in-error); font-size: 12px; }
  .actions { display: flex; justify-content: flex-end; gap: 6px; }
  .actions button { padding: 3px 10px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg-bar); color: var(--text); font-size: 12px; }
  .num { padding: 0 6px; text-align: right; color: var(--text-muted); user-select: none; }
  .code { white-space: pre; padding-left: 14px; position: relative; }
  .code::before { position: absolute; left: 3px; color: var(--text-muted); }
  .added { background: color-mix(in srgb, var(--running) 16%, transparent); }
  .added .code::before { content: "+"; }
  .removed { background: color-mix(in srgb, var(--in-error) 16%, transparent); }
  .removed .code::before { content: "−"; }
  .expand { display: block; width: 100%; padding: 2px 8px; border: none; border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); background: var(--bg-hover); color: var(--text-muted); font-size: 11px; text-align: left; cursor: pointer; }
  .expand:hover:not(:disabled) { color: var(--text); }
</style>
