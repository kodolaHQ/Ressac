<script lang="ts" module>
  import type { Node } from "@xyflow/svelte";
  import type { Pastille } from "./badges";

  export type NodeData = {
    /** Block name, or its id. */
    titre: string;
    type: string;
    pastille: Pastille | null;
    /** Validator message when it targets this block. */
    erreur: string | null;
    avertissements: string[];
    entree: boolean;
    sortie: boolean;
  };
  export type BlockNode = Node<NodeData, "bloc">;

  /** Badge color: the same scale as the home page. */
  const TINTS: Record<string, "ok" | "moyen" | "echec" | "neutre" | "en-cours"> = {
    reussi: "ok",
    partiel: "moyen",
    echoue: "echec",
    interrompu: "echec",
    "pas-lance": "neutre",
    repris: "neutre",
    "en-cours": "en-cours",
  };
</script>

<script lang="ts">
  import { Handle, Position, type NodeProps } from "@xyflow/svelte";

  let { id, data, selected }: NodeProps<BlockNode> = $props();
  const marque = $derived(data.erreur ?? (data.avertissements.length ? data.avertissements.join("\n") : null));
</script>

<div
  class="noeud"
  class:selectionne={selected}
  class:en-erreur={data.erreur !== null}
  class:avertit={data.erreur === null && data.avertissements.length > 0}
  data-testid="noeud-{id}"
  title={marque}
>
  {#if data.entree}<Handle type="target" position={Position.Left} />{/if}
  <div class="ligne">
    <b class="titre">{data.titre}</b>
    {#if data.pastille}
      <span class="pastille {TINTS[data.pastille.statut] ?? 'neutre'}" data-testid="pastille-{id}" title={data.pastille.statut}
        >{data.pastille.elements ?? ""}</span
      >
    {/if}
  </div>
  <div class="ligne doux">
    <code>{data.type}</code>
    {#if data.erreur !== null}<span class="marque" aria-label="Erreur">!</span>
    {:else if data.avertissements.length}<span class="marque" aria-label="Avertissement">⚠</span>{/if}
  </div>
  {#if data.sortie}<Handle type="source" position={Position.Right} />{/if}
</div>

<style>
  .noeud {
    width: 200px;
    box-sizing: border-box;
    padding: 8px 10px;
    border-radius: 8px;
    border: 1px solid var(--bord);
    background: var(--fond-barre);
    color: var(--texte);
    font-size: 12px;
  }
  .noeud.selectionne { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
  .noeud.en-erreur { border-color: var(--en-erreur); }
  .noeud.avertit { border-color: var(--en-cours); }
  .ligne { display: flex; align-items: center; gap: 6px; min-width: 0; }
  .ligne + .ligne { margin-top: 4px; }
  .titre { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
  .doux { color: var(--texte-doux); }
  code { font-size: 11px; padding: 0 5px; border-radius: 4px; background: var(--fond-survol); }
  .marque { margin-left: auto; font-weight: 700; }
  .en-erreur .marque { color: var(--en-erreur); }
  .avertit .marque { color: var(--en-cours); }
  .pastille { flex: none; min-width: 18px; height: 18px; padding: 0 5px; box-sizing: border-box; border-radius: 9px; font-size: 11px; line-height: 18px; text-align: center; color: white; background: var(--arretee); }
  .pastille.ok { background: var(--en-marche); }
  .pastille.moyen, .pastille.en-cours { background: var(--en-cours); }
  .pastille.echec { background: var(--en-erreur); }
</style>
