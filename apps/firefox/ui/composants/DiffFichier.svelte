<script lang="ts">
  import type { Commentaire, DiffFichier } from "../../shared/api";
  import { EXPANDED_LINES, NOT_DISPLAYABLE, RANGE_OUTSIDE_BLOCK } from "../../shared/modele";
  import { api } from "../etat.svelte";
  import CommentaireRelecture from "./CommentaireRelecture.svelte";

  /**
   * A file's unified diff; the lines hidden between hunks unfold by 20. The code stays read-only: the margin's `+`
   * opens a comment on a hunk line (Shift+click or drag extend the range, within the hunk).
   */
  let {
    projet,
    jeton,
    diff,
    commentaires,
    surChange,
  }: { projet: string; jeton: string; diff: DiffFichier; commentaires: Commentaire[]; surChange: () => void } = $props();

  type Bloc = DiffFichier["blocs"][number];
  /** Position of a hunk line: its new number, the next line's for a removal (like the kernel). */
  function position(b: Bloc, i: number): number {
    for (let k = i; k < b.lignes.length; k++) {
      const n = b.lignes[k]!.nouveau;
      if (n !== null) return n;
    }
    return b.nouveauDebut + b.nouveauNombre;
  }

  /** The range in progress: its hunk, the anchor line and the other end (indices in the hunk). */
  let selection = $state<{ bloc: number; ancre: number; bout: number } | null>(null);
  let glisse = $state(false);
  let texte = $state("");
  let erreur = $state<string | null>(null);
  let envoi = $state(false);

  const plage = $derived.by(() => {
    if (!selection) return null;
    const b = diff.blocs[selection.bloc]!;
    const p1 = position(b, selection.ancre);
    const p2 = position(b, selection.bout);
    const debut = Math.min(p1, p2);
    const fin = Math.max(p1, p2);
    let derniere = -1;
    b.lignes.forEach((_, k) => {
      const p = position(b, k);
      if (p >= debut && p <= fin) derniere = k;
    });
    return { bloc: selection.bloc, debut, fin, derniere };
  });
  const choisie = (bloc: number, k: number) => {
    if (!plage || plage.bloc !== bloc) return false;
    const p = position(diff.blocs[bloc]!, k);
    return p >= plage.debut && p <= plage.fin;
  };

  /** `+` pressed: a new range, or (Shift) the other end of the current range, refused outside its hunk. */
  function viser(bloc: number, k: number, etendre: boolean) {
    erreur = null;
    if (etendre && selection) {
      if (selection.bloc !== bloc) {
        erreur = RANGE_OUTSIDE_BLOCK;
        selection = { ...selection, bout: selection.ancre };
        return;
      }
      selection = { ...selection, bout: k };
      return;
    }
    if (!selection) texte = "";
    selection = { bloc, ancre: k, bout: k };
    glisse = true;
  }
  /** While dragging: the range follows the mouse, within the hunk only. */
  function survol(bloc: number, k: number) {
    if (glisse && selection && selection.bloc === bloc) selection = { ...selection, bout: k };
  }
  function fermer() {
    selection = null;
    texte = "";
    erreur = null;
  }
  async function valider() {
    if (!plage || envoi) return;
    envoi = true;
    try {
      const r = await api.relecture.commenter(projet, jeton, { fichier: diff.chemin, debut: plage.debut, fin: plage.fin, texte });
      if (r.ok) {
        fermer();
        surChange();
      } else erreur = r.erreur;
    } catch {
      erreur = "Le commentaire n'a pas pu être enregistré.";
    } finally {
      envoi = false;
    }
  }
  function touche(e: KeyboardEvent) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void valider();
    } else if (e.key === "Escape") {
      e.preventDefault();
      fermer();
    }
  }

  /** Each comment under the last shown line of its range (first hunk that has the line `fin`); otherwise at the top. */
  const places = $derived.by(() => {
    const sous = new Map<string, Commentaire[]>();
    const ailleurs: Commentaire[] = [];
    for (const c of commentaires) {
      let ou: string | null = null;
      for (let i = 0; i < diff.blocs.length && ou === null; i++) {
        const b = diff.blocs[i]!;
        for (let k = b.lignes.length - 1; k >= 0; k--) {
          if (position(b, k) === c.fin) {
            ou = `${i}:${k}`;
            break;
          }
        }
      }
      if (ou === null) ailleurs.push(c);
      else sous.set(ou, [...(sous.get(ou) ?? []), c]);
    }
    return { sous, ailleurs };
  });

  type Ligne = { marque: " " | "+" | "-"; texte: string; ancien: number | null; nouveau: number | null };
  /** Unfolded lines of each gap (before hunk i; i = number of hunks: after the last one). */
  type Intervalle = { lignes: Ligne[]; fini: boolean };
  let intervalles = $state<Record<number, Intervalle>>({});
  let charge = $state<number | null>(null);

  const debutBloc = (b: DiffFichier["blocs"][number]) => (b.nouveauNombre === 0 ? b.nouveauDebut + 1 : b.nouveauDebut);
  const finBloc = (b: DiffFichier["blocs"][number]) => (b.nouveauNombre === 0 ? b.nouveauDebut + 1 : b.nouveauDebut + b.nouveauNombre);

  /** The hidden gap before hunk i: first new lines, last one (null: to the end of the file), old − new offset. */
  function cache(i: number): { debut: number; fin: number | null; decalage: number } | null {
    const blocs = diff.blocs;
    if (diff.statut === "supprime" || blocs.length === 0) return null;
    if (i === blocs.length) {
      if (diff.statut === "ajoute") return null;
      const d = blocs[i - 1]!;
      return { debut: finBloc(d), fin: null, decalage: d.ancienDebut + d.ancienNombre - (d.nouveauDebut + d.nouveauNombre) };
    }
    const b = blocs[i]!;
    const debut = i === 0 ? 1 : finBloc(blocs[i - 1]!);
    return { debut, fin: debutBloc(b) - 1, decalage: b.ancienDebut - b.nouveauDebut };
  }

  function restant(i: number): { debut: number; fin: number | null; decalage: number } | null {
    const c = cache(i);
    if (!c) return null;
    const deja = intervalles[i];
    if (deja?.fini) return null;
    const debut = c.debut + (deja?.lignes.length ?? 0);
    if (c.fin !== null && debut > c.fin) return null;
    return { ...c, debut };
  }

  async function deplier(i: number) {
    const r = restant(i);
    if (!r || charge !== null) return;
    charge = i;
    try {
      const fin = r.fin === null ? r.debut + EXPANDED_LINES - 1 : Math.min(r.fin, r.debut + EXPANDED_LINES - 1);
      const textes = await api.relecture.lignes(projet, jeton, diff.chemin, r.debut, fin);
      const deja = intervalles[i]?.lignes ?? [];
      const nouvelles = textes.map((texte, k) => ({ marque: " " as const, texte, nouveau: r.debut + k, ancien: r.debut + k + r.decalage }));
      const toutes = [...deja, ...nouvelles];
      const fini = textes.length < fin - r.debut + 1 || (r.fin !== null && r.debut + textes.length > r.fin);
      intervalles = { ...intervalles, [i]: { lignes: toutes, fini } };
    } catch {
      intervalles = { ...intervalles, [i]: { lignes: intervalles[i]?.lignes ?? [], fini: true } };
    } finally {
      charge = null;
    }
  }

  const classe = (l: Ligne) => (l.marque === "+" ? "ajout" : l.marque === "-" ? "retrait" : "contexte");
</script>

{#snippet rangee(l: Ligne)}
  <div class="ligne {classe(l)}" data-testid="ligne-diff" data-ancien={l.ancien ?? ""} data-nouveau={l.nouveau ?? ""}><span class="marge"></span><span class="num">{l.ancien ?? ""}</span><span class="num">{l.nouveau ?? ""}</span><span class="code">{l.texte}</span></div>
{/snippet}

{#snippet rangeeBloc(l: Ligne, bloc: number, k: number)}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="ligne {classe(l)}"
    class:choisie={choisie(bloc, k)}
    data-testid="ligne-diff"
    data-ancien={l.ancien ?? ""}
    data-nouveau={l.nouveau ?? ""}
    onmouseenter={() => survol(bloc, k)}
  ><span class="marge"><button
        class="ajouter"
        data-testid="ajouter-commentaire"
        aria-label="Commenter la ligne {position(diff.blocs[bloc]!, k)}"
        title="Commenter (Maj+clic ou glisser : plusieurs lignes)"
        onmousedown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          viser(bloc, k, e.shiftKey);
        }}
        onclick={(e) => {
          // Keyboard (Enter, Space): no mousedown.
          if (e.detail === 0) viser(bloc, k, e.shiftKey);
        }}></button
      ></span><span class="num">{l.ancien ?? ""}</span><span class="num">{l.nouveau ?? ""}</span><span class="code">{l.texte}</span></div>
  {#each places.sous.get(`${bloc}:${k}`) ?? [] as c (c.id)}<CommentaireRelecture {projet} commentaire={c} {surChange} />{/each}
  {#if plage && plage.bloc === bloc && plage.derniere === k}
    <form class="formulaire" data-testid="formulaire-commentaire" onsubmit={(e) => { e.preventDefault(); void valider(); }}>
      <div class="plage">{plage.debut === plage.fin ? `Ligne ${plage.debut}` : `Lignes ${plage.debut}–${plage.fin}`}</div>
      <!-- svelte-ignore a11y_autofocus -->
      <textarea bind:value={texte} rows="3" autofocus placeholder="Commentaire (texte simple, Markdown montré tel quel)" onkeydown={touche}></textarea>
      {#if erreur}<p class="erreur" data-testid="erreur-commentaire">{erreur}</p>{/if}
      <div class="actions">
        <button type="button" onclick={fermer}>Annuler</button>
        <button type="submit" disabled={envoi || texte.trim() === ""}>Commenter</button>
      </div>
    </form>
  {/if}
{/snippet}

{#snippet intervalle(i: number)}
  {#each intervalles[i]?.lignes ?? [] as l (l.nouveau)}{@render rangee(l)}{/each}
  {#if restant(i)}
    <button class="deplier" data-testid="deplier-contexte" disabled={charge !== null} onclick={() => void deplier(i)}>Afficher les lignes cachées</button>
  {/if}
{/snippet}

<svelte:window onmouseup={() => (glisse = false)} />

<section class="diff" data-testid="diff-fichier" aria-label="Diff de {diff.chemin}">
  <h3 class="chemin">{diff.chemin}</h3>
  {#each places.ailleurs as c (c.id)}<CommentaireRelecture {projet} commentaire={c} {surChange} />{/each}
  {#if diff.affichable !== true}
    <p class="non-affichable">{NOT_DISPLAYABLE[diff.affichable]}</p>
  {:else if diff.blocs.length === 0}
    <p class="non-affichable">Aucune ligne modifiée.</p>
  {:else}
    <div class="code-diff">
      {#each diff.blocs as b, i (i)}
        {@render intervalle(i)}
        {#each b.lignes as l, k (k)}{@render rangeeBloc(l, i, k)}{/each}
      {/each}
      {@render intervalle(diff.blocs.length)}
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
