<script lang="ts">
  // The site app window's bar: FenetreSite, frozen, on window.webaios.site (ui/site-api.ts).
  import FenetreSite from "../ui/site/FenetreSite.svelte";
</script>

<FenetreSite />

<style>
  /* Firefox keeps its native title bar (browser.tabs.inTitlebar 0): no room to leave for the macOS window buttons. */
  :global(body header.mac[data-testid="barre-site"]) {
    padding-left: 8px;
  }
</style>
