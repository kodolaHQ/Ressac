<script lang="ts" module>
  /** Le jeton de la comparaison montrée par chaque onglet : une page remontée la retrouve telle quelle. */
  const jetons = new Map<string, string>();
</script>

<script lang="ts">
  import type { Commentaire, DiffFichier as Diff, FichierModifie, VueRelecture } from "../../commun/api";
  import { api } from "../etat.svelte";
  import DiffFichier from "./DiffFichier.svelte";

  /**
   * La page Relecture d'un projet : ce qui a changé depuis la dernière relecture, avec des commentaires sur les lignes.
   * La comparaison est faite à l'ouverture et gardée telle quelle jusqu'à « Rafraîchir » ; « Marquer comme relu »
   * retient ce qu'elle montre.
   */
  let { projet, ongletId }: { projet: string; ongletId: string } = $props();
  let jeton = $state<string | null>(null);

  let vue = $state<VueRelecture | null>(null);
  let choisi = $state<string | null>(null);
  let diff = $state<Diff | null>(null);
  let erreurDiff = $state<string | null>(null);
  let enCours = $state(false);
  let commentaires = $state<Commentaire[]>([]);
  let message = $state<string | null>(null);
  let requete = 0;
  let requeteCommentaires = 0;
  let requeteDiff = 0;

  const STATUTS = { ajoute: "+", supprime: "−", modifie: "~" } as const;
  const LIBELLES = { ajoute: "ajouté", supprime: "supprimé", modifie: "modifié" } as const;

  /** `garder` : la comparaison de l'onglet si elle est encore gardée ; sinon (« Rafraîchir ») une nouvelle. */
  async function charger(garder: boolean) {
    const n = ++requete;
    enCours = true;
    try {
      const v = await api.relecture.ouvrir(projet, garder ? jetons.get(ongletId) : undefined);
      if (n !== requete) return;
      await montrer(v);
    } catch {
      if (n === requete) vue = { etat: "indisponible", nom: "", raison: "la relecture n'a pas pu être ouverte" };
    } finally {
      if (n === requete) enCours = false;
    }
  }

  /** Une comparaison reçue (ouverture, « Rafraîchir », « Marquer comme relu ») : son jeton, ses fichiers, ses commentaires. */
  async function montrer(v: VueRelecture) {
    ++requeteCommentaires;
    vue = v;
    commentaires = v.etat === "ok" ? v.commentaires : [];
    jeton = v.etat === "ok" ? v.jeton : null;
    if (jeton) jetons.set(ongletId, jeton);
    else jetons.delete(ongletId);
    const fichiers = v.etat === "ok" ? v.comparaison.fichiers : [];
    // Le fichier choisi reste choisi s'il est encore modifié ; sinon le premier.
    const garde = fichiers.find((f) => f.chemin === choisi) ?? fichiers[0];
    choisi = garde?.chemin ?? null;
    await afficher(choisi);
  }

  /** Les commentaires relus après un changement (ajout, modification, recollage d'un fichier affiché). */
  async function rechargerCommentaires() {
    const n = ++requeteCommentaires;
    try {
      const l = await api.relecture.commentaires(projet);
      if (n === requeteCommentaires) commentaires = l;
    } catch {
      // La liste reste celle d'avant.
    }
  }

  const sansPrefixe = (e: unknown) =>
    e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(e);

  async function envoyerCommentaires() {
    message = null;
    enCours = true;
    try {
      const r = await api.relecture.envoyer(projet);
      if (!r.ok) message = r.erreur;
    } catch (e) {
      message = sansPrefixe(e);
    } finally {
      enCours = false;
      await rechargerCommentaires();
    }
  }

  async function marquerRelu() {
    if (jeton === null) return;
    message = null;
    const n = ++requete;
    enCours = true;
    try {
      const v = await api.relecture.relu(projet, jeton);
      if (n === requete) await montrer(v);
    } catch (e) {
      if (n === requete) message = sansPrefixe(e);
    } finally {
      if (n === requete) enCours = false;
    }
  }

  /** Rouvrir le fichier déjà affiché relit le même diff (même jeton) : l'affichage, avec son commentaire en cours, n'est pas remonté. */
  async function afficher(chemin: string | null) {
    const n = ++requeteDiff;
    choisi = chemin;
    erreurDiff = null;
    if (chemin === null || jeton === null) {
      diff = null;
      return;
    }
    try {
      const d = await api.relecture.fichier(projet, jeton, chemin);
      if (n === requeteDiff) diff = d;
      // L'ouverture du fichier a recollé ses commentaires au diff.
      await rechargerCommentaires();
    } catch {
      if (n === requeteDiff) {
        diff = null;
        erreurDiff = "Ce fichier n'est plus dans cette comparaison : Rafraîchis la relecture.";
      }
    }
  }

  $effect(() => {
    void projet;
    void ongletId;
    void charger(true);
  });

  const fichiers = $derived<FichierModifie[]>(vue?.etat === "ok" ? vue.comparaison.fichiers : []);
  const aEnvoyer = $derived(commentaires.filter((c) => !c.resolu).length);
  const duFichier = $derived(diff ? commentaires.filter((c) => c.fichier === diff!.chemin) : []);
</script>

<section class="relecture" data-testid="page-relecture" aria-label="Relecture">
  <header>
    <h2>{vue?.nom ?? ""}</h2>
    {#if vue?.etat === "ok"}
      {#if aEnvoyer > 0}
        <button data-testid="envoyer-commentaires" disabled={enCours || vue.destination === null} title={vue.sansDestination ?? ""}
          onclick={() => void envoyerCommentaires()}
          >Envoyer {aEnvoyer} commentaire{aEnvoyer > 1 ? "s" : ""} à {vue.destination ?? "personne"}</button
        >
      {/if}
      <button data-testid="marquer-relu" disabled={enCours || jeton === null} onclick={() => void marquerRelu()}>Marquer comme relu</button>
    {/if}
    <button onclick={() => void charger(false)} disabled={enCours}>Rafraîchir</button>
  </header>
  {#if message}<p class="message" data-testid="erreur-relecture">{message}</p>{/if}
  {#if vue?.etat === "indisponible"}
    <p class="indisponible" data-testid="relecture-indisponible">Relecture indisponible : {vue.raison}</p>
  {:else if vue?.etat === "ok"}
    <div class="corps">
      <nav class="liste" aria-label="Fichiers modifiés">
        {#if fichiers.length === 0}
          <p class="vide">Rien n'a changé depuis la dernière relecture.</p>
        {/if}
        {#each fichiers as f (f.chemin)}
          <button class="fichier" class:choisi={f.chemin === choisi} data-testid="fichier-relecture" aria-pressed={f.chemin === choisi}
            title={LIBELLES[f.statut]} onclick={() => void afficher(f.chemin)}
            ><span class="statut {f.statut}">{STATUTS[f.statut]}</span><span class="nom-fichier">{f.chemin}</span><span class="compte">+{f.ajouts} −{f.suppressions}</span></button
          >
        {/each}
        {#if commentaires.length > 0}
          <h3>Commentaires</h3>
          <ul class="commentaires">
            {#each commentaires as c (c.id)}
              <li data-testid="commentaire-relecture" class:resolu={c.resolu}>
                <span class="ou">{c.fichier}:{c.debut}{c.fin !== c.debut ? `–${c.fin}` : ""}</span>
                <span>{c.texte}</span>
              </li>
            {/each}
          </ul>
        {/if}
      </nav>
      <div class="centre">
        {#if erreurDiff}
          <p class="vide">{erreurDiff}</p>
        {:else if diff && jeton}
          {#key `${jeton}\n${diff.chemin}`}<DiffFichier {projet} {jeton} {diff} commentaires={duFichier} surChange={() => void rechargerCommentaires()} />{/key}
        {/if}
      </div>
    </div>
  {/if}
</section>

<style>
  .relecture { height: 100%; display: flex; flex-direction: column; padding: 16px 20px; box-sizing: border-box; overflow: hidden; color: var(--texte); background: var(--fond); }
  header { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
  h2 { margin: 0; font-size: 16px; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  h3 { margin: 16px 0 6px; font-size: 12px; color: var(--texte-doux); }
  button { padding: 4px 10px; border-radius: 6px; border: 1px solid var(--bord); background: var(--fond-barre); color: var(--texte); font-size: 12px; }
  button:hover:not(:disabled) { background: var(--fond-survol); }
  .indisponible, .vide { color: var(--texte-doux); }
  .message { margin: 0 0 8px; color: var(--en-erreur); font-size: 12px; }
  .corps { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(180px, 260px) 1fr; gap: 16px; }
  .liste { overflow: auto; display: flex; flex-direction: column; gap: 2px; }
  .fichier { display: flex; align-items: center; gap: 8px; text-align: left; border: none; background: transparent; padding: 4px 6px; }
  .fichier.choisi { background: var(--fond-actif); }
  .statut { width: 12px; font-family: ui-monospace, Menlo, monospace; font-weight: 700; }
  .statut.ajoute { color: var(--en-marche); }
  .statut.supprime { color: var(--en-erreur); }
  .nom-fichier { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .compte { font-size: 11px; color: var(--texte-doux); white-space: nowrap; }
  .commentaires { list-style: none; margin: 0; padding: 0; font-size: 12px; }
  .commentaires li { padding: 4px 6px; border-bottom: 1px solid var(--bord); display: flex; flex-direction: column; }
  .commentaires li.resolu { opacity: 0.6; }
  .ou { color: var(--texte-doux); font-family: ui-monospace, Menlo, monospace; }
  .centre { overflow: auto; min-width: 0; }
</style>
