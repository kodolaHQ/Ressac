<script lang="ts" module>
  import type { Node } from "@xyflow/svelte";
  import type { Badge } from "./badges";

  export type NodeData = {
    /** Block name, or its id. */
    title: string;
    type: string;
    badge: Badge | null;
    /** Validator message when it targets this block. */
    error: string | null;
    warnings: string[];
    input: boolean;
    output: boolean;
  };
  export type BlockNode = Node<NodeData, "block">;

  /** Badge color: the same scale as the home page. */
  const TINTS: Record<string, "ok" | "warn" | "bad" | "neutral" | "in-progress"> = {
    succeeded: "ok",
    partial: "warn",
    failed: "bad",
    interrupted: "bad",
    "not-run": "neutral",
    resumed: "neutral",
    running: "in-progress",
  };
</script>

<script lang="ts">
  import { Handle, Position, type NodeProps } from "@xyflow/svelte";

  let { id, data, selected }: NodeProps<BlockNode> = $props();
  const mark = $derived(data.error ?? (data.warnings.length ? data.warnings.join("\n") : null));
</script>

<div
  class="node"
  class:selected={selected}
  class:in-error={data.error !== null}
  class:warns={data.error === null && data.warnings.length > 0}
  data-testid="node-{id}"
  title={mark}
>
  {#if data.input}<Handle type="target" position={Position.Left} />{/if}
  <div class="line">
    <b class="title">{data.title}</b>
    {#if data.badge}
      <span class="pill {TINTS[data.badge.status] ?? 'neutral'}" data-testid="pill-{id}" title={data.badge.status}
        >{data.badge.items ?? ""}</span
      >
    {/if}
  </div>
  <div class="line muted">
    <code>{data.type}</code>
    {#if data.error !== null}<span class="mark" aria-label="Erreur">!</span>
    {:else if data.warnings.length}<span class="mark" aria-label="Avertissement">⚠</span>{/if}
  </div>
  {#if data.output}<Handle type="source" position={Position.Right} />{/if}
</div>

<style>
  .node {
    width: 200px;
    box-sizing: border-box;
    padding: 8px 10px;
    border-radius: 8px;
    border: 1px solid var(--border);
    background: var(--bg-bar);
    color: var(--text);
    font-size: 12px;
  }
  .node.selected { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
  .node.in-error { border-color: var(--in-error); }
  .node.warns { border-color: var(--in-progress); }
  .line { display: flex; align-items: center; gap: 6px; min-width: 0; }
  .line + .line { margin-top: 4px; }
  .title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
  .muted { color: var(--text-muted); }
  code { font-size: 11px; padding: 0 5px; border-radius: 4px; background: var(--bg-hover); }
  .mark { margin-left: auto; font-weight: 700; }
  .in-error .mark { color: var(--in-error); }
  .warns .mark { color: var(--in-progress); }
  .pill { flex: none; min-width: 18px; height: 18px; padding: 0 5px; box-sizing: border-box; border-radius: 9px; font-size: 11px; line-height: 18px; text-align: center; color: white; background: var(--stopped); }
  .pill.ok { background: var(--running); }
  .pill.warn, .pill.in-progress { background: var(--in-progress); }
  .pill.bad { background: var(--in-error); }
</style>
