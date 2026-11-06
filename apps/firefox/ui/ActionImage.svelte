<script lang="ts">
  import type { ContextePage, ImagePage } from "../../navigateur/src/renderer/action/types";

  /**
   * Electron's ImagePage for Firefox: a result image, checked by the host then loaded by the chrome without cookies or
   * referrer (ui/actions-api.ts image), shown as a `data:` URL. Neutral (an action with an account), pending or refused:
   * a neutral placeholder of the same size.
   */
  let { image, ctx }: { image: NonNullable<ImagePage>; ctx: ContextePage } = $props();
  let data = $state<string | null>(null);

  $effect(() => {
    data = null;
    if (!("url" in image)) return;
    let current = true;
    void window.webaios.actions.image(ctx.action, ctx.execution, image.url).then(
      (d) => current && (data = d),
      () => {},
    );
    return () => (current = false);
  });
</script>

{#if "url" in image && data?.startsWith("data:")}
  <img class="pa-image" src={data} alt="" />
{:else}
  <div class="pa-image-neutre" data-testid="image-neutre" aria-hidden="true"></div>
{/if}
