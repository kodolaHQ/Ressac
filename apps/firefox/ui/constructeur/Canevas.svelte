<script lang="ts">
  import { Background, Controls, SvelteFlow, useSvelteFlow, type Connection, type Edge, type NodeTypes } from "@xyflow/svelte";
  import { untrack } from "svelte";
  import type { CatalogueBloc } from "@webaios/noyau";
  import { relier, supprimerBlocs, supprimerLien } from "./brouillon";
  import { GLISSER_BLOC } from "./ajout";
  import type { Edition } from "./edition.svelte";
  import NoeudBloc, { type NoeudBloc as Noeud } from "./NoeudBloc.svelte";
  import type { Pastille } from "./pastilles";

  /** Half of a displayed block: a dropped block is centered on the targeted point. */
  const DEMI = { x: 100, y: 30 };
  /** Small enough for a 30-block workflow (about ten columns) to fit whole in the view on opening. */
  const MIN_ZOOM = 0.2;

  let {
    edition,
    catalogue,
    pastilles,
    onselection,
    onajouter,
  }: {
    edition: Edition;
    catalogue: Map<string, CatalogueBloc>;
    pastilles: Record<string, Pastille>;
    onselection: (bloc: string | null) => void;
    onajouter: (type: string, position: { x: number; y: number }) => void;
  } = $props();

  const flow = useSvelteFlow();
  const nodeTypes: NodeTypes = { bloc: NoeudBloc };
  let zone: HTMLDivElement;
  let nodes = $state.raw<Noeud[]>([]);
  let edges = $state.raw<Edge[]>([]);

  /** A block is being dragged: the canvas is not redrawn under the mouse, only at the end. */
  let reporte = false;

  /** Nodes and links drawn from the draft (the shown selection is kept). */
  function reconstruire(): void {
    const b = edition.brouillon;
    if (!b) return;
    const actuels = untrack(() => nodes);
    if (actuels.some((n) => n.dragging)) {
      reporte = true;
      return;
    }
    reporte = false;
    const selectionnes = new Set(actuels.filter((n) => n.selected).map((n) => n.id));
    const avecEntree = new Set(b.liens.map((l) => l.vers));
    const avecSortie = new Set(b.liens.map((l) => l.de));
    const erreurBloc = edition.validation.ok ? null : (edition.validation.bloc ?? null);
    const erreur = edition.validation.ok ? null : edition.validation.erreur;
    nodes = b.blocs.map((x) => {
      const c = catalogue.get(x.type);
      // A block with an optional input but no input has no input handle, except a `code` that reads its input.
      const sansEntree = c?.entree === "facultative" && !(x.type === "code" && x.parametres.appel !== "recolte");
      return {
        id: x.id,
        type: "bloc" as const,
        position: edition.positions[x.id] ?? x.position,
        selected: selectionnes.has(x.id),
        deletable: x.type !== "sortie",
        data: {
          titre: x.nom ?? x.id,
          type: x.type,
          pastille: pastilles[x.id] ?? null,
          erreur: erreurBloc === x.id ? erreur : null,
          avertissements: edition.avertissements.filter((a) => a.bloc === x.id).map((a) => a.message),
          entree: !sansEntree || avecEntree.has(x.id),
          sortie: x.type !== "sortie" || avecSortie.has(x.id),
        },
      };
    });
    edges = b.liens.map((l) => ({ id: `${l.de}->${l.vers}`, source: l.de, target: l.vers }));
  }

  $effect(() => {
    void [edition.brouillon, edition.positions, edition.validation, edition.avertissements, pastilles, catalogue];
    reconstruire();
  });

  function relie(c: Connection): void {
    edition.modifier((b) => relier(b, c.source, c.target));
    // A refused link (from the output, duplicate…) disappears.
    reconstruire();
  }

  function supprime({ nodes: n, edges: e }: { nodes: Noeud[]; edges: Edge[] }): void {
    edition.modifier((b) => supprimerBlocs(e.reduce((r, l) => supprimerLien(r, l.source, l.target), b), n.map((x) => x.id)));
    reconstruire();
  }

  function deplace(): void {
    edition.deplacer(Object.fromEntries(nodes.map((n) => [n.id, { x: Math.round(n.position.x), y: Math.round(n.position.y) }])));
    // A change that arrived during the drag (file, badges) is drawn now.
    if (reporte) setTimeout(reconstruire, 0);
  }

  function depose(e: DragEvent): void {
    const type = e.dataTransfer?.getData(GLISSER_BLOC);
    if (!type) return;
    e.preventDefault();
    const p = flow.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    onajouter(type, { x: p.x - DEMI.x, y: p.y - DEMI.y });
  }

  /** Center of the view, in canvas coordinates (top-left corner of a centered block). */
  export function centre(): { x: number; y: number } {
    const r = zone.getBoundingClientRect();
    const p = flow.screenToFlowPosition({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
    return { x: p.x - DEMI.x, y: p.y - DEMI.y };
  }

  /** Puts the shown selection back on `id` (a block change refused by the user). */
  export function selectionner(id: string | null): void {
    nodes = nodes.map((n) => (n.selected === (n.id === id) ? n : { ...n, selected: n.id === id }));
  }

  export function ajusterVue(): void {
    void flow.fitView({ maxZoom: 1 });
  }
</script>

<div
  class="canevas"
  bind:this={zone}
  role="application"
  aria-label="Canevas du workflow"
  ondragover={(e) => {
    if (e.dataTransfer?.types.includes(GLISSER_BLOC)) e.preventDefault();
  }}
  ondrop={depose}
>
  <SvelteFlow
    bind:nodes
    bind:edges
    {nodeTypes}
    colorMode="system"
    nodeDragThreshold={4}
    minZoom={MIN_ZOOM}
    deleteKey={["Delete", "Backspace"]}
    fitView={edition.viewport === null}
    fitViewOptions={{ maxZoom: 1 }}
    initialViewport={edition.viewport ?? undefined}
    proOptions={{ hideAttribution: true }}
    onconnect={relie}
    onbeforedelete={async ({ nodes: n, edges: e }) => ({ nodes: n.filter((x) => x.data.type !== "sortie"), edges: e })}
    ondelete={supprime}
    onnodedragstop={deplace}
    onselectiondragstop={deplace}
    onselectionchange={({ nodes: n }) => onselection(n.length === 1 ? n[0]!.id : null)}
    onmoveend={(_e, vp) => (edition.viewport = vp)}
  >
    <Background />
    <Controls showLock={false} />
  </SvelteFlow>
</div>

<style>
  .canevas { position: relative; width: 100%; height: 100%; min-width: 0; min-height: 0; }
  .canevas :global(.svelte-flow) { --xy-background-color: var(--fond); }
</style>
