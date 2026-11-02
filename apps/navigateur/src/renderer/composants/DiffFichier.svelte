<script lang="ts">
  import type { DiffFichier } from "../../commun/api";
  import { LIGNES_DEPLIEES, NON_AFFICHABLE } from "../../commun/modele";
  import { api } from "../etat.svelte";

  /** Le diff unifié d'un fichier, en lecture seule ; les lignes cachées entre les blocs se déplient par 20. */
  let { projet, jeton, diff }: { projet: string; jeton: string; diff: DiffFichier } = $props();

  type Ligne = { marque: " " | "+" | "-"; texte: string; ancien: number | null; nouveau: number | null };
  /** Lignes dépliées de chaque intervalle (avant le bloc i ; i = nombre de blocs : après le dernier). */
  type Intervalle = { lignes: Ligne[]; fini: boolean };
  let intervalles = $state<Record<number, Intervalle>>({});
  let charge = $state<number | null>(null);

  const debutBloc = (b: DiffFichier["blocs"][number]) => (b.nouveauNombre === 0 ? b.nouveauDebut + 1 : b.nouveauDebut);
  const finBloc = (b: DiffFichier["blocs"][number]) => (b.nouveauNombre === 0 ? b.nouveauDebut + 1 : b.nouveauDebut + b.nouveauNombre);

  /** L'intervalle caché avant le bloc i : premières lignes nouvelles, dernière (null : jusqu'à la fin du fichier), décalage ancien − nouveau. */
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
      const fin = r.fin === null ? r.debut + LIGNES_DEPLIEES - 1 : Math.min(r.fin, r.debut + LIGNES_DEPLIEES - 1);
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
  <div class="ligne {classe(l)}" data-testid="ligne-diff" data-ancien={l.ancien ?? ""} data-nouveau={l.nouveau ?? ""}><span class="num">{l.ancien ?? ""}</span><span class="num">{l.nouveau ?? ""}</span><span class="code">{l.texte}</span></div>
{/snippet}

{#snippet intervalle(i: number)}
  {#each intervalles[i]?.lignes ?? [] as l (l.nouveau)}{@render rangee(l)}{/each}
  {#if restant(i)}
    <button class="deplier" data-testid="deplier-contexte" disabled={charge !== null} onclick={() => void deplier(i)}>Afficher les lignes cachées</button>
  {/if}
{/snippet}

<section class="diff" data-testid="diff-fichier" aria-label="Diff de {diff.chemin}">
  <h3 class="chemin">{diff.chemin}</h3>
  {#if diff.affichable !== true}
    <p class="non-affichable">{NON_AFFICHABLE[diff.affichable]}</p>
  {:else if diff.blocs.length === 0}
    <p class="non-affichable">Aucune ligne modifiée.</p>
  {:else}
    <div class="code-diff">
      {#each diff.blocs as b, i (i)}
        {@render intervalle(i)}
        {#each b.lignes as l, k (k)}{@render rangee(l)}{/each}
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
  .ligne { display: grid; grid-template-columns: 44px 44px 1fr; }
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
