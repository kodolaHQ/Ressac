<script lang="ts">
  import type { Commentaire, DiffFichier } from "../../shared/api";
  import { EXPANDED_LINES, NOT_DISPLAYABLE, RANGE_OUTSIDE_BLOCK } from "../../shared/model";
  import { api } from "../state.svelte";
  import ReviewComment from "./ReviewComment.svelte";

  /**
   * A file's unified diff; the lines hidden between hunks unfold by 20. The code stays read-only: the margin's `+`
   * opens a comment on a hunk line (Shift+click or drag extend the range, within the hunk).
   */
  let {
    projet: project,
    jeton: token,
    diff,
    commentaires: comments,
    surChange: onChange,
  }: { projet: string; jeton: string; diff: DiffFichier; commentaires: Commentaire[]; surChange: () => void } = $props();

  type Block = DiffFichier["blocs"][number];
  /** Position of a hunk line: its new number, the next line's for a removal (like the kernel). */
  function position(b: Block, i: number): number {
    for (let k = i; k < b.lignes.length; k++) {
      const n = b.lignes[k]!.nouveau;
      if (n !== null) return n;
    }
    return b.nouveauDebut + b.nouveauNombre;
  }

  /** The range in progress: its hunk, the anchor line and the other end (indices in the hunk). */
  let selection = $state<{ bloc: number; ancre: number; bout: number } | null>(null);
  let dragged = $state(false);
  let text = $state("");
  let error = $state<string | null>(null);
  let sending = $state(false);

  const range = $derived.by(() => {
    if (!selection) return null;
    const b = diff.blocs[selection.bloc]!;
    const p1 = position(b, selection.ancre);
    const p2 = position(b, selection.bout);
    const start = Math.min(p1, p2);
    const end = Math.max(p1, p2);
    let last = -1;
    b.lignes.forEach((_, k) => {
      const p = position(b, k);
      if (p >= start && p <= end) last = k;
    });
    return { bloc: selection.bloc, debut: start, fin: end, derniere: last };
  });
  const chosen = (block: number, k: number) => {
    if (!range || range.bloc !== block) return false;
    const p = position(diff.blocs[block]!, k);
    return p >= range.debut && p <= range.fin;
  };

  /** `+` pressed: a new range, or (Shift) the other end of the current range, refused outside its hunk. */
  function aim(block: number, k: number, expand: boolean) {
    error = null;
    if (expand && selection) {
      if (selection.bloc !== block) {
        error = RANGE_OUTSIDE_BLOCK;
        selection = { ...selection, bout: selection.ancre };
        return;
      }
      selection = { ...selection, bout: k };
      return;
    }
    if (!selection) text = "";
    selection = { bloc: block, ancre: k, bout: k };
    dragged = true;
  }
  /** While dragging: the range follows the mouse, within the hunk only. */
  function hover(block: number, k: number) {
    if (dragged && selection && selection.bloc === block) selection = { ...selection, bout: k };
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
      const r = await api.relecture.commenter(project, token, { fichier: diff.chemin, debut: range.debut, fin: range.fin, texte: text });
      if (r.ok) {
        close();
        onChange();
      } else error = r.erreur;
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
    const sub = new Map<string, Commentaire[]>();
    const elsewhere: Commentaire[] = [];
    for (const c of comments) {
      let where: string | null = null;
      for (let i = 0; i < diff.blocs.length && where === null; i++) {
        const b = diff.blocs[i]!;
        for (let k = b.lignes.length - 1; k >= 0; k--) {
          if (position(b, k) === c.fin) {
            where = `${i}:${k}`;
            break;
          }
        }
      }
      if (where === null) elsewhere.push(c);
      else sub.set(where, [...(sub.get(where) ?? []), c]);
    }
    return { sous: sub, ailleurs: elsewhere };
  });

  type Line = { marque: " " | "+" | "-"; texte: string; ancien: number | null; nouveau: number | null };
  /** Unfolded lines of each gap (before hunk i; i = number of hunks: after the last one). */
  type Interval = { lignes: Line[]; fini: boolean };
  let intervals = $state<Record<number, Interval>>({});
  let onLoaded = $state<number | null>(null);

  const blockStart = (b: DiffFichier["blocs"][number]) => (b.nouveauNombre === 0 ? b.nouveauDebut + 1 : b.nouveauDebut);
  const blockEnd = (b: DiffFichier["blocs"][number]) => (b.nouveauNombre === 0 ? b.nouveauDebut + 1 : b.nouveauDebut + b.nouveauNombre);

  /** The hidden gap before hunk i: first new lines, last one (null: to the end of the file), old − new offset. */
  function cache(i: number): { debut: number; fin: number | null; decalage: number } | null {
    const blocks = diff.blocs;
    if (diff.statut === "supprime" || blocks.length === 0) return null;
    if (i === blocks.length) {
      if (diff.statut === "ajoute") return null;
      const d = blocks[i - 1]!;
      return { debut: blockEnd(d), fin: null, decalage: d.ancienDebut + d.ancienNombre - (d.nouveauDebut + d.nouveauNombre) };
    }
    const b = blocks[i]!;
    const start = i === 0 ? 1 : blockEnd(blocks[i - 1]!);
    return { debut: start, fin: blockStart(b) - 1, decalage: b.ancienDebut - b.nouveauDebut };
  }

  function remaining(i: number): { debut: number; fin: number | null; decalage: number } | null {
    const c = cache(i);
    if (!c) return null;
    const already = intervals[i];
    if (already?.fini) return null;
    const start = c.debut + (already?.lignes.length ?? 0);
    if (c.fin !== null && start > c.fin) return null;
    return { ...c, debut: start };
  }

  async function expand(i: number) {
    const r = remaining(i);
    if (!r || onLoaded !== null) return;
    onLoaded = i;
    try {
      const end = r.fin === null ? r.debut + EXPANDED_LINES - 1 : Math.min(r.fin, r.debut + EXPANDED_LINES - 1);
      const texts = await api.relecture.lignes(project, token, diff.chemin, r.debut, end);
      const already = intervals[i]?.lignes ?? [];
      const fresh = texts.map((text, k) => ({ marque: " " as const, texte: text, nouveau: r.debut + k, ancien: r.debut + k + r.decalage }));
      const all = [...already, ...fresh];
      const finished = texts.length < end - r.debut + 1 || (r.fin !== null && r.debut + texts.length > r.fin);
      intervals = { ...intervals, [i]: { lignes: all, fini: finished } };
    } catch {
      intervals = { ...intervals, [i]: { lignes: intervals[i]?.lignes ?? [], fini: true } };
    } finally {
      onLoaded = null;
    }
  }

  const cls = (l: Line) => (l.marque === "+" ? "ajout" : l.marque === "-" ? "retrait" : "contexte");
</script>

{#snippet row(l: Line)}
  <div class="ligne {cls(l)}" data-testid="ligne-diff" data-ancien={l.ancien ?? ""} data-nouveau={l.nouveau ?? ""}><span class="marge"></span><span class="num">{l.ancien ?? ""}</span><span class="num">{l.nouveau ?? ""}</span><span class="code">{l.texte}</span></div>
{/snippet}

{#snippet blockRow(l: Line, block: number, k: number)}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="ligne {cls(l)}"
    class:choisie={chosen(block, k)}
    data-testid="ligne-diff"
    data-ancien={l.ancien ?? ""}
    data-nouveau={l.nouveau ?? ""}
    onmouseenter={() => hover(block, k)}
  ><span class="marge"><button
        class="ajouter"
        data-testid="ajouter-commentaire"
        aria-label="Commenter la ligne {position(diff.blocs[block]!, k)}"
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
      ></span><span class="num">{l.ancien ?? ""}</span><span class="num">{l.nouveau ?? ""}</span><span class="code">{l.texte}</span></div>
  {#each places.sous.get(`${block}:${k}`) ?? [] as c (c.id)}<ReviewComment projet={project} commentaire={c} surChange={onChange} />{/each}
  {#if range && range.bloc === block && range.derniere === k}
    <form class="formulaire" data-testid="formulaire-commentaire" onsubmit={(e) => { e.preventDefault(); void validate(); }}>
      <div class="plage">{range.debut === range.fin ? `Ligne ${range.debut}` : `Lignes ${range.debut}–${range.fin}`}</div>
      <!-- svelte-ignore a11y_autofocus -->
      <textarea bind:value={text} rows="3" autofocus placeholder="Commentaire (texte simple, Markdown montré tel quel)" onkeydown={key}></textarea>
      {#if error}<p class="erreur" data-testid="erreur-commentaire">{error}</p>{/if}
      <div class="actions">
        <button type="button" onclick={close}>Annuler</button>
        <button type="submit" disabled={sending || text.trim() === ""}>Commenter</button>
      </div>
    </form>
  {/if}
{/snippet}

{#snippet interval(i: number)}
  {#each intervals[i]?.lignes ?? [] as l (l.nouveau)}{@render row(l)}{/each}
  {#if remaining(i)}
    <button class="deplier" data-testid="deplier-contexte" disabled={onLoaded !== null} onclick={() => void expand(i)}>Afficher les lignes cachées</button>
  {/if}
{/snippet}

<svelte:window onmouseup={() => (dragged = false)} />

<section class="diff" data-testid="diff-fichier" aria-label="Diff de {diff.chemin}">
  <h3 class="chemin">{diff.chemin}</h3>
  {#each places.ailleurs as c (c.id)}<ReviewComment projet={project} commentaire={c} surChange={onChange} />{/each}
  {#if diff.affichable !== true}
    <p class="non-affichable">{NOT_DISPLAYABLE[diff.affichable]}</p>
  {:else if diff.blocs.length === 0}
    <p class="non-affichable">Aucune ligne modifiée.</p>
  {:else}
    <div class="code-diff">
      {#each diff.blocs as b, i (i)}
        {@render interval(i)}
        {#each b.lignes as l, k (k)}{@render blockRow(l, i, k)}{/each}
      {/each}
      {@render interval(diff.blocs.length)}
    </div>
  {/if}
</section>

<style>
  .diff { min-width: 0; }
  .chemin { margin: 0 0 8px; font-size: 13px; font-weight: 600; overflow-wrap: anywhere; }
  .non-affichable { color: var(--texte-doux); }
  .code-diff { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 12px; line-height: 1.5; border: 1px solid var(--bord); border-radius: 6px; overflow: auto; }
  .ligne { display: grid; grid-template-columns: 18px 44px 44px 1fr; }
  .ligne.choisie { box-shadow: inset 3px 0 0 var(--accent, #3b82f6); background: color-mix(in srgb, var(--accent, #3b82f6) 14%, transparent); }
  .marge { display: flex; align-items: center; justify-content: center; }
  .ajouter { width: 16px; height: 16px; padding: 0; border: none; border-radius: 4px; background: var(--accent, #3b82f6); color: white; font-size: 12px; line-height: 16px; cursor: pointer; opacity: 0; }
  /* The « + » through CSS: it does not enter the line's text. */
  .ajouter::before { content: "+"; }
  .ligne:hover .ajouter, .ajouter:focus-visible { opacity: 1; }
  .formulaire { margin: 4px 8px 8px 106px; padding: 8px; border: 1px solid var(--bord); border-radius: 6px; background: var(--fond); font-family: system-ui, sans-serif; display: flex; flex-direction: column; gap: 6px; }
  .formulaire textarea { font: inherit; font-size: 12px; resize: vertical; padding: 6px; border: 1px solid var(--bord); border-radius: 4px; background: var(--fond-barre); color: var(--texte); }
  .plage { font-size: 11px; color: var(--texte-doux); }
  .erreur { margin: 0; color: var(--en-erreur); font-size: 12px; }
  .actions { display: flex; justify-content: flex-end; gap: 6px; }
  .actions button { padding: 3px 10px; border-radius: 6px; border: 1px solid var(--bord); background: var(--fond-barre); color: var(--texte); font-size: 12px; }
  .num { padding: 0 6px; text-align: right; color: var(--texte-doux); user-select: none; }
  .code { white-space: pre; padding-left: 14px; position: relative; }
  .code::before { position: absolute; left: 3px; color: var(--texte-doux); }
  .ajout { background: color-mix(in srgb, var(--en-marche) 16%, transparent); }
  .ajout .code::before { content: "+"; }
  .retrait { background: color-mix(in srgb, var(--en-erreur) 16%, transparent); }
  .retrait .code::before { content: "−"; }
  .deplier { display: block; width: 100%; padding: 2px 8px; border: none; border-top: 1px solid var(--bord); border-bottom: 1px solid var(--bord); background: var(--fond-survol); color: var(--texte-doux); font-size: 11px; text-align: left; cursor: pointer; }
  .deplier:hover:not(:disabled) { color: var(--texte); }
</style>
