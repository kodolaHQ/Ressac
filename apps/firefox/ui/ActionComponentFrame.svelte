<script lang="ts">
  /**
   * An agent component in a sandboxed opaque frame (`sandbox="allow-scripts"`),
   * served from its sanitized resource:// copy (chrome/store/action-media.ts), served again on each actions.change (the
   * agent may have rewritten it: a new mtime, a new URL). It gets its props, the theme and its width by message; its
   * `parent.postMessage` reaches the chrome as a `webaios-composant` event (the copy's bridge), listened on the window
   * root. It can only ask for its height; anything else, a `webaiosOuvrir` link included, is ignored.
   */
  let { nom, props }: { nom: string; props: Record<string, unknown> } = $props();

  const HAUTEUR_MIN = 20;
  const HAUTEUR_MAX = 2000;
  const actions = window.webaios.actions;
  let iframe = $state<HTMLIFrameElement>();
  let src = $state<string | null>(null);
  let largeur = $state(0);
  let hauteur = $state(150);
  const sombre = matchMedia("(prefers-color-scheme: dark)");
  let theme = $state<"clair" | "sombre">(sombre.matches ? "sombre" : "clair");

  $effect(() => {
    const suivre = () => (theme = sombre.matches ? "sombre" : "clair");
    sombre.addEventListener("change", suivre);
    return () => sombre.removeEventListener("change", suivre);
  });

  /** The frame shows the current copy: never an older copy, nor a page it navigated to. */
  const ours = () => !!src && iframe?.contentDocument?.documentURI === src;

  function envoyer() {
    // Opaque origin: « * » is the only possible target; only the current copy receives.
    if (ours()) iframe?.contentWindow?.postMessage({ type: "composant", props: $state.snapshot(props), theme, largeur }, "*");
  }
  // On each change (the load goes through DOMFrameContentLoaded).
  $effect(() => {
    void [props, theme, largeur];
    envoyer();
  });

  // Served on mount and on each actions.change; each serve is paired with a release, the last one when unmounted.
  $effect(() => {
    const n = nom;
    let alive = true;
    let held = 0;
    const serve = () => {
      held++;
      void actions.serveComponent(n).then(
        (u) => {
          if (!alive) return;
          // Serves of one name resolve in order: the older copy's reference goes once the newer one is known.
          if (held > 1) {
            held--;
            actions.releaseComponent(n);
          }
          src = u;
        },
        () => {},
      );
    };
    serve();
    const off = actions.surChange(serve);
    return () => {
      alive = false;
      off();
      for (; held > 0; held--) actions.releaseComponent(n);
    };
  });

  $effect(() => {
    const surMessage = (e: Event) => {
      if (!iframe || e.target !== iframe.contentWindow || !ours()) return;
      // The component can dispatch this event itself, with any detail.
      const detail: unknown = (e as CustomEvent).detail;
      if (typeof detail !== "string") return;
      let d: unknown;
      try {
        d = JSON.parse(detail);
      } catch {
        return;
      }
      if (typeof d !== "object" || d === null) return;
      const { type, px } = d as { type?: unknown; px?: unknown };
      if (type !== "hauteur" || typeof px !== "number" || !Number.isFinite(px)) return;
      hauteur = Math.round(Math.min(HAUTEUR_MAX, Math.max(HAUTEUR_MIN, px)));
    };
    // The window root sees the events of the window's in-process frames (SiteHomeFrame.svelte); untrusted ones too.
    const root = (window as unknown as { windowRoot: EventTarget }).windowRoot;
    (root.addEventListener as (t: string, l: EventListener, c: boolean, untrusted: boolean) => void)("webaios-composant", surMessage, true, true);
    // An iframe of this chrome page never gets `load`: DOMFrameContentLoaded comes once the component's scripts have run.
    const charge = (e: Event) => iframe && e.target === iframe && envoyer();
    document.addEventListener("DOMFrameContentLoaded", charge, true);
    return () => {
      root.removeEventListener("webaios-composant", surMessage, true);
      document.removeEventListener("DOMFrameContentLoaded", charge, true);
    };
  });
</script>

<div data-testid="bloc-{nom}" bind:clientWidth={largeur}>
  <iframe
    bind:this={iframe}
    class="pa-composant"
    data-testid="cadre-composant"
    title={nom}
    src={src ?? "about:blank"}
    sandbox="allow-scripts"
    style:height="{hauteur}px"
  ></iframe>
</div>
