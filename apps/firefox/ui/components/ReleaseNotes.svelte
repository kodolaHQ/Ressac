<script lang="ts">
  import { RELEASE_NOTES } from "../../shared/release-notes";
</script>

<!-- The internal « Nouveautés » page: opened once after an update, and from Réglages › À propos. -->
<section class="notes" data-testid="release-notes">
  <div class="content">
    <h1>Nouveautés</h1>
    {#each RELEASE_NOTES as n (n.version)}
      <article data-testid="release-{n.version}">
        <h2>WebAiOs {n.version} <span>{n.date}</span></h2>
        <ul class="panel">
          {#each n.items as item (item)}<li>{item}</li>{/each}
        </ul>
      </article>
    {/each}
  </div>
</section>

<style>
  .notes { height: 100%; overflow-y: auto; color: var(--text); font-size: 13px; }
  .content { max-width: 720px; margin: 0 auto; padding: 26px 32px; animation: webaios-rise var(--spring-d) var(--spring) backwards; }
  h1 { margin: 0 0 22px; font: 650 26px/1.1 var(--font-display); letter-spacing: -0.02em; }
  h2 { margin: 22px 4px 8px; font: 600 15px var(--font-ui); }
  h2 span { margin-left: 6px; font-weight: 400; color: var(--text-muted); }
  .panel { margin: 0; padding: 0; list-style: none; border: 1px solid var(--border); border-radius: 16px; background: var(--sheet); box-shadow: var(--lift); overflow: hidden; }
  li { padding: 11px 14px; line-height: 1.45; }
  li + li { border-top: 1px solid var(--border); }
</style>
