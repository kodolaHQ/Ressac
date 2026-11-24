<script lang="ts">
  import { RELEASE_NOTES } from "../../shared/release-notes";
  import { t } from "../i18n.svelte";
  import { api } from "../state.svelte";
  // Inlined as a data: URL: no file to list in the engine's jar, and the page loads nothing from the network.
  import passport from "../assets/passport-video.jpg?inline";

  const POSTERS = { passport };
</script>

<!-- The internal « Nouveautés » page: opened once after an update, and from Réglages › À propos. -->
<section class="notes" data-testid="release-notes">
  <div class="content">
    <h1>{t("home-notes-title")}</h1>
    {#each RELEASE_NOTES as n (n.version)}
      <article data-testid="release-{n.version}">
        <h2>Ressac {n.version} <span>{n.date}</span></h2>
        {#if n.video}
          {@const v = n.video}
          <button class="video panel" class:poster={!!v.poster} data-testid="release-video" onclick={() => api.dispatch({ type: "openTab", windowId: api.windowId, url: v.url, activate: true, agentReached: false })}>
            {#if v.poster}<img src={POSTERS[v.poster]} alt="" />{/if}
            <span class="play" aria-hidden="true"></span>
            <span class="label">{v.title}</span>
          </button>
        {/if}
        <ul class="panel">
          {#each n.items as item (item)}<li>{item}</li>{/each}
        </ul>
      </article>
    {/each}
  </div>
</section>

<style>
  .notes { height: 100%; overflow-y: auto; color: var(--text); font-size: 13px; }
  .content { max-width: 720px; margin: 0 auto; padding: 26px 32px; animation: ressac-rise var(--spring-d) var(--spring) backwards; }
  h1 { margin: 0 0 22px; font: 650 26px/1.1 var(--font-display); letter-spacing: -0.02em; }
  h2 { margin: 22px 4px 8px; font: 600 15px var(--font-ui); }
  h2 span { margin-left: 6px; font-weight: 400; color: var(--text-muted); }
  .panel { margin: 0; padding: 0; list-style: none; border: 1px solid var(--border); border-radius: 16px; background: var(--sheet); box-shadow: var(--lift); overflow: hidden; }
  li { padding: 11px 14px; line-height: 1.45; }
  li + li { border-top: 1px solid var(--border); }
  .video { position: relative; display: grid; place-items: center; width: 100%; aspect-ratio: 16 / 9; margin: 0 0 10px; padding: 0; color: var(--text); font: inherit; cursor: pointer; transition: transform var(--spring-d) var(--spring); }
  .video:hover { transform: translateY(-1px); }
  .video:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .video img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
  .play { position: relative; width: 56px; height: 56px; border-radius: 50%; background: var(--sheet); box-shadow: var(--lift); }
  .play::after { content: ""; position: absolute; left: 22px; top: 17px; border-style: solid; border-width: 11px 0 11px 18px; border-color: transparent transparent transparent var(--text); }
  /* On a poster the play mark moves to a corner: the picture's middle is its subject. */
  .poster .play { position: absolute; right: 14px; bottom: 12px; width: 40px; height: 40px; }
  .poster .play::after { left: 16px; top: 12px; border-width: 8px 0 8px 13px; }
  .label { position: absolute; left: 14px; bottom: 12px; padding: 4px 10px; border-radius: 999px; background: var(--sheet); font-weight: 600; }
</style>
