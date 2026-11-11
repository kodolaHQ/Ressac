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
      // The list stays the previous one.
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

<section class="review" data-testid="review-page" aria-label="Relecture">
  <header>
    <h2>{view?.name ?? ""}</h2>
    {#if view?.state === "ok"}
      {#if toSend > 0}
        <button data-testid="send-comments" disabled={running || view.destination === null} title={view.noDestination ?? ""}
          onclick={() => void sendComments()}
          >Envoyer {toSend} commentaire{toSend > 1 ? "s" : ""} à {view.destination ?? "personne"}</button
        >
      {/if}
      <button data-testid="mark-read" disabled={running || token === null} onclick={() => void markReviewed()}>Marquer comme relu</button>
    {/if}
    <button onclick={() => void load(false)} disabled={running}>Rafraîchir</button>
  </header>
  {#if message}<p class="message" data-testid="review-error">{message}</p>{/if}
  {#if view?.state === "unavailable"}
    <p class="unavailable" data-testid="review-unavailable">Relecture indisponible : {view.reason}</p>
  {:else if view?.state === "ok"}
    <div class="body">
      <nav class="list" aria-label="Fichiers modifiés">
        {#if files.length === 0}
          <p class="empty">Rien n'a changé depuis la dernière relecture.</p>
        {/if}
        {#each files as f (f.path)}
          <button class="file" class:chosen={f.path === chosen} data-testid="review-file" aria-pressed={f.path === chosen}
            title={LABELS[f.status]} onclick={() => void display(f.path)}
            ><span class="status {f.status}">{STATUSES[f.status]}</span><span class="file-name">{f.path}</span><span class="account">+{f.additions} −{f.deletions}</span></button
          >
        {/each}
        {#if comments.length > 0}
          <h3>Commentaires</h3>
          <ul class="comments">
            {#each comments as c (c.id)}
              <li data-testid="review-comment" class:resolved={c.resolved}>
                <span class="or">{c.file}:{c.start}{c.end !== c.start ? `–${c.end}` : ""}</span>
                <span>{c.text}</span>
              </li>
            {/each}
          </ul>
        {/if}
      </nav>
      <div class="center">
        {#if diffError}
          <p class="empty">{diffError}</p>
        {:else if diff && token}
          {#key `${token}\n${diff.path}`}<DiffFile project={project} token={token} {diff} comments={ofFile} onChange={() => void reloadComments()} />{/key}
        {/if}
      </div>
    </div>
  {/if}
</section>

<style>
  .review { height: 100%; display: flex; flex-direction: column; padding: 16px 20px; box-sizing: border-box; overflow: hidden; color: var(--text); background: var(--bg); }
  header { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
  h2 { margin: 0; font: 600 18px/1.2 var(--font-display); letter-spacing: -0.01em; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  h3 { margin: 16px 0 6px; font: 600 12px/1.2 var(--font-display); letter-spacing: 0.01em; color: var(--text-muted); }
  button { padding: 5px 12px; border-radius: 10px; border: 1px solid var(--border); background: var(--glass-hi); color: var(--text); font: 500 12px var(--font-ui); cursor: pointer; transition: transform var(--tap), background var(--tap); }
  button:hover:not(:disabled) { background: var(--bg-active); }
  button:active:not(:disabled) { transform: scale(0.97); }
  .unavailable, .empty { color: var(--text-muted); }
  .message { margin: 0 0 8px; color: var(--in-error); font-size: 12px; }
  .body { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(180px, 260px) 1fr; gap: 16px; }
  .list { overflow: auto; display: flex; flex-direction: column; gap: 2px; }
  .file { display: flex; align-items: center; gap: 8px; text-align: left; border: none; background: transparent; padding: 6px 8px; }
  .file.chosen { background: var(--glass-hi); box-shadow: inset 0 0 0 1px var(--glass-edge), inset 3px 0 0 var(--accent); }
  .status { width: 12px; font-family: var(--font-mono); font-weight: 700; }
  .status.added { color: var(--running); }
  .status.deleted { color: var(--in-error); }
  .file-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .account { font-size: 11px; color: var(--text-muted); white-space: nowrap; }
  .comments { list-style: none; margin: 0; padding: 0; font-size: 12px; }
  .comments li { padding: 4px 6px; border-bottom: 1px solid var(--border); display: flex; flex-direction: column; }
  .comments li.resolved { opacity: 0.6; }
  .or { color: var(--text-muted); font-family: var(--font-mono); }
  .center { overflow: auto; min-width: 0; }
</style>
