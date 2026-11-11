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
    padding: 10px 12px;
    border-radius: 14px;
    border: 1px solid var(--border);
    background: var(--sheet);
    box-shadow: var(--float);
    color: var(--text);
    font-size: 12px;
    transition: box-shadow var(--tap), border-color var(--tap);
  }
  .node.selected { border-color: var(--accent); box-shadow: var(--float), 0 0 0 3px color-mix(in oklab, var(--accent) 22%, transparent); }
  .node.in-error { border-color: var(--in-error); }
  .node.warns { border-color: var(--in-progress); }
  .line { display: flex; align-items: center; gap: 6px; min-width: 0; }
  .line + .line { margin-top: 4px; }
  .title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 650 13px/1.2 var(--font-display); letter-spacing: -0.01em; }
  .muted { color: var(--text-muted); }
  code { font: 10.5px var(--font-mono); padding: 1px 6px; border-radius: 6px; background: color-mix(in oklab, var(--a1) 14%, var(--glass-hi)); }
  .mark { margin-left: auto; font-weight: 700; }
  .in-error .mark { color: var(--in-error); }
  .warns .mark { color: var(--in-progress); }
  .pill { flex: none; min-width: 18px; height: 18px; padding: 0 5px; box-sizing: border-box; border-radius: 9px; font-size: 11px; line-height: 18px; text-align: center; color: var(--on-color); background: var(--stopped); }
  .pill.ok { background: var(--running); }
  .pill.warn, .pill.in-progress { background: var(--in-progress); }
  .pill.bad { background: var(--in-error); }
</style>
