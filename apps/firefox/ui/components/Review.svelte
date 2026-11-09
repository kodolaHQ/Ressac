<script lang="ts" module>
  /** The token of the comparison shown by each tab: a remounted page finds it as is. */
  const tokens = new Map<string, string>();
</script>

<script lang="ts">
  import type { DiffComment, DiffFile as Diff, ModifiedFile, ReviewView } from "../../shared/api";
  import { api } from "../state.svelte";
  import DiffFile from "./DiffFile.svelte";

  /**
   * A project's Review page: what changed since the last review, with comments on lines. The comparison is made at
   * opening and kept as is until « Rafraîchir »; « Marquer comme relu » records what it shows.
   */
  let { project: project, tabId: tabId }: { project: string; tabId: string } = $props();
  let token = $state<string | null>(null);

  let view = $state<ReviewView | null>(null);
  let chosen = $state<string | null>(null);
  let diff = $state<Diff | null>(null);
  let diffError = $state<string | null>(null);
  let running = $state(false);
  let comments = $state<DiffComment[]>([]);
  let message = $state<string | null>(null);
  let request = 0;
  let commentsRequest = 0;
  let diffRequest = 0;

  const STATUSES = { added: "+", deleted: "−", modified: "~" } as const;
  const LABELS = { added: "ajouté", deleted: "supprimé", modified: "modifié" } as const;

  /** `garder`: the tab's comparison if it is still kept; otherwise (« Rafraîchir ») a new one. */
  async function load(keep: boolean) {
    const n = ++request;
    running = true;
    try {
      const v = await api.review.open(project, keep ? tokens.get(tabId) : undefined);
      if (n !== request) return;
      await show(v);
    } catch {
      if (n === request) view = { state: "unavailable", name: "", reason: "la relecture n'a pas pu être ouverte" };
    } finally {
      if (n === request) running = false;
    }
  }

  /** A received comparison (opening, « Rafraîchir », « Marquer comme relu »): its token, its files, its comments. */
  async function show(v: ReviewView) {
    ++commentsRequest;
    view = v;
    comments = v.state === "ok" ? v.comments : [];
    token = v.state === "ok" ? v.token : null;
    if (token) tokens.set(tabId, token);
    else tokens.delete(tabId);
    const files = v.state === "ok" ? v.comparison.files : [];
    // The chosen file stays chosen if it is still modified; otherwise the first one.
    const kept = files.find((f) => f.path === chosen) ?? files[0];
    chosen = kept?.path ?? null;
    await display(chosen);
  }

  /** Comments re-read after a change (add, edit, reattachment of a shown file). */
  async function reloadComments() {
    const n = ++commentsRequest;
    try {
      const l = await api.review.comments(project);
      if (n === commentsRequest) comments = l;
    } catch {
      // La liste reste celle d'avant.
    }
  }

  const withoutPrefix = (e: unknown) =>
    e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(e);

  async function sendComments() {
    message = null;
    running = true;
    try {
      const r = await api.review.send(project);
      if (!r.ok) message = r.error;
    } catch (e) {
      message = withoutPrefix(e);
    } finally {
      running = false;
      await reloadComments();
    }
  }

  async function markReviewed() {
    if (token === null) return;
    message = null;
    const n = ++request;
    running = true;
    try {
      const v = await api.review.reviewed(project, token);
      if (n === request) await show(v);
    } catch (e) {
      if (n === request) message = withoutPrefix(e);
    } finally {
      if (n === request) running = false;
    }
  }

  /** Reopening the file already shown re-reads the same diff (same token): the display, with its comment in progress, is not remounted. */
  async function display(path: string | null) {
    const n = ++diffRequest;
    chosen = path;
    diffError = null;
    if (path === null || token === null) {
      diff = null;
      return;
    }
    try {
      const d = await api.review.file(project, token, path);
      if (n === diffRequest) diff = d;
      // Opening the file reattached its comments to the diff.
      await reloadComments();
    } catch {
      if (n === diffRequest) {
        diff = null;
        diffError = "Ce fichier n'est plus dans cette comparaison : Rafraîchis la relecture.";
      }
    }
  }

  $effect(() => {
    void project;
    void tabId;
    void load(true);
  });

  const files = $derived<ModifiedFile[]>(view?.state === "ok" ? view.comparison.files : []);
  const toSend = $derived(comments.filter((c) => !c.resolved).length);
  const ofFile = $derived(diff ? comments.filter((c) => c.file === diff!.path) : []);
</script>

<section class="relecture" data-testid="page-relecture" aria-label="Relecture">
  <header>
    <h2>{view?.name ?? ""}</h2>
    {#if view?.state === "ok"}
      {#if toSend > 0}
        <button data-testid="envoyer-commentaires" disabled={running || view.destination === null} title={view.noDestination ?? ""}
          onclick={() => void sendComments()}
          >Envoyer {toSend} commentaire{toSend > 1 ? "s" : ""} à {view.destination ?? "personne"}</button
        >
      {/if}
      <button data-testid="marquer-relu" disabled={running || token === null} onclick={() => void markReviewed()}>Marquer comme relu</button>
    {/if}
    <button onclick={() => void load(false)} disabled={running}>Rafraîchir</button>
  </header>
  {#if message}<p class="message" data-testid="erreur-relecture">{message}</p>{/if}
  {#if view?.state === "unavailable"}
    <p class="indisponible" data-testid="relecture-indisponible">Relecture indisponible : {view.reason}</p>
  {:else if view?.state === "ok"}
    <div class="corps">
      <nav class="liste" aria-label="Fichiers modifiés">
        {#if files.length === 0}
          <p class="vide">Rien n'a changé depuis la dernière relecture.</p>
        {/if}
        {#each files as f (f.path)}
          <button class="fichier" class:choisi={f.path === chosen} data-testid="fichier-relecture" aria-pressed={f.path === chosen}
            title={LABELS[f.status]} onclick={() => void display(f.path)}
            ><span class="statut {f.status}">{STATUSES[f.status]}</span><span class="nom-fichier">{f.path}</span><span class="compte">+{f.additions} −{f.deletions}</span></button
          >
        {/each}
        {#if comments.length > 0}
          <h3>Commentaires</h3>
          <ul class="commentaires">
            {#each comments as c (c.id)}
              <li data-testid="commentaire-relecture" class:resolu={c.resolved}>
                <span class="ou">{c.file}:{c.start}{c.end !== c.start ? `–${c.end}` : ""}</span>
                <span>{c.text}</span>
              </li>
            {/each}
          </ul>
        {/if}
      </nav>
      <div class="centre">
        {#if diffError}
          <p class="vide">{diffError}</p>
        {:else if diff && token}
          {#key `${token}\n${diff.path}`}<DiffFile project={project} token={token} {diff} comments={ofFile} onChange={() => void reloadComments()} />{/key}
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
  .statut.added { color: var(--en-marche); }
  .statut.deleted { color: var(--en-erreur); }
  .nom-fichier { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .compte { font-size: 11px; color: var(--texte-doux); white-space: nowrap; }
  .commentaires { list-style: none; margin: 0; padding: 0; font-size: 12px; }
  .commentaires li { padding: 4px 6px; border-bottom: 1px solid var(--bord); display: flex; flex-direction: column; }
  .commentaires li.resolu { opacity: 0.6; }
  .ou { color: var(--texte-doux); font-family: ui-monospace, Menlo, monospace; }
  .centre { overflow: auto; min-width: 0; }
</style>
