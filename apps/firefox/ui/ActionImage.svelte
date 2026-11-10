<script lang="ts">
  import type { PageContext, ImageRef } from "../ui/action/types";

  /**
   * A result image, checked by the host then loaded by the chrome without cookies or
   * referrer (ui/actions-api.ts image), shown as a `data:` URL. Neutral (an action with an account), pending, refused or
   * undecodable: a neutral placeholder of the same size. Asked only once near the view (lazy loading).
   */
  let { image, ctx }: { image: NonNullable<ImageRef>; ctx: PageContext } = $props();
  let data = $state<string | null>(null);
  let slot = $state<HTMLDivElement>();
  let near = $state(false);

  $effect(() => {
    if (near || !slot) return;
    // The page's scroll container as root, so the margin counts in it (an implicit root would clip at its edge).
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && (near = true), {
      root: slot.closest(".scrolled"),
      rootMargin: "600px",
    });
    io.observe(slot);
    return () => io.disconnect();
  });

  // Primitives: a page read again gives new objects with the same values, which must not ask for the image again.
  const action = $derived(ctx.action);
  const execution = $derived(ctx.run);
  const url = $derived("url" in image ? image.url : null);

  $effect(() => {
    data = null;
    if (!near || !url) return;
    let current = true;
    void window.webaios.actions.image(action, execution, url).then(
      (d) => current && (data = d),
      () => {},
    );
    return () => (current = false);
  });
</script>

{#if url && data?.startsWith("data:")}
  <img class="pa-image" src={data} alt="" onerror={() => (data = null)} />
{:else}
  <div class="pa-image-neutral" data-testid="neutral-image" aria-hidden="true" bind:this={slot}></div>
{/if}
