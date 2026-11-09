<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { api } from "../ui/etat.svelte";

  /**
   * A widget shown in its isolated frame: without allow-same-origin, the code written by the agent runs in an opaque
   * origin, with no access to the interface. It receives its data through postMessage; its links go through
   * api.accueil.ouvrir.
   */
  let {
    widget,
    donnees,
    taille,
    etat,
  }: {
    widget: { id: string; nom: string; src: string | null };
    donnees: unknown;
    taille: { l: number; h: number };
    etat: { statut: string; derniereMaj: string | null };
  } = $props();

  let iframe = $state<HTMLIFrameElement>();
  let largeur = $state(0);
  let hauteur = $state(0);

  function envoyer() {
    brancherGeste();
    // The frame has an opaque origin (sandbox without allow-same-origin): « * » is the only possible target.
    iframe?.contentWindow?.postMessage(
      {
        type: "widget",
        donnees: $state.snapshot(donnees),
        taille: { l: taille.l, h: taille.h },
        px: { largeur, hauteur },
        etat: { statut: etat.statut, derniereMaj: etat.derniereMaj },
      },
      "*",
    );
  }
  // On each change of data, state or size (loading goes through DOMFrameContentLoaded).
  $effect(() => {
    void [donnees, etat.statut, etat.derniereMaj, taille.l, taille.h, largeur, hauteur];
    envoyer();
  });

  // The widget only takes the keyboard under the pointer (a click by the user): a focus() from its code is handed back
  // to the interface element that had it.
  let avant = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
  function surFocusin(e: FocusEvent) {
    if (e.target instanceof HTMLElement && e.target !== iframe) avant = e.target;
  }
  function surBlur() {
    setTimeout(() => {
      if (!iframe || !document.hasFocus() || document.activeElement !== iframe || iframe.matches(":hover")) return;
      if (avant?.isConnected) avant.focus();
      else iframe.blur();
    });
  }

  function surMessage(e: MessageEvent) {
    // The origin of a sandboxed frame is opaque (« null »): the source, never the origin, identifies it.
    if (!iframe || e.source !== iframe.contentWindow) return;
    const d: unknown = e.data;
    if (typeof d !== "object" || d === null) return;
    const { type, url } = d as { type?: unknown; url?: unknown };
    if (type !== "ouvrir" || typeof url !== "string") return;
    // The main process only opens the link if a real click by the user just landed in this widget (one link per click).
    api.accueil.ouvrir(url, widget.id);
  }

  // The guard is a script at the top of the served copy; it removes WebRTC last, so while RTCPeerConnection is still
  // there it could not fully install: no press is recorded then (fail closed). This listener is set by the chrome,
  // which the widget can neither remove nor imitate (isTrusted).
  let fenetreGeste: Window | null = null;
  function geste(e: PointerEvent) {
    if (e.isTrusted) api.accueil.geste(widget.id);
  }
  // The widget's link: `webaiosOuvrir` (provided by the guard in the page's world) emits this event, which the
  // parent chrome listens to (an opaque origin cannot post it a message). The request stays subject to the gesture.
  function lien(e: Event) {
    api.accueil.ouvrir(String((e as CustomEvent).detail), widget.id);
  }
  function detacherGeste() {
    fenetreGeste?.removeEventListener("pointerdown", geste, true);
    fenetreGeste?.removeEventListener("webaios-ouvrir", lien, true);
    fenetreGeste = null;
  }
  function brancherGeste() {
    detacherGeste();
    // The document's window (defaultView) rather than the frame proxy: it is the one that receives the events.
    const cadre = iframe?.contentDocument?.defaultView ?? iframe?.contentWindow;
    if (!cadre) return;
    // No condition on the guard: the gesture is an `isTrusted` press seen by the chrome, which the page cannot
    // forge; the guard's state does not change that. It protects data output, not this link.
    fenetreGeste = cadre as unknown as Window;
    cadre.addEventListener("pointerdown", geste as EventListener, true);
    cadre.addEventListener("webaios-ouvrir", lien, true);
  }
  onMount(brancherGeste);
  onDestroy(detacherGeste);

  function surCharge() {
    envoyer();
    brancherGeste();
  }
  // An iframe of this chrome page never gets `load` (measured: neither the element nor its `onload`), so the data would
  // never reach a display loaded after its last change. DOMFrameContentLoaded (chrome only, seen from the document) comes
  // once the display's scripts have run.
  $effect(() => {
    const charge = (e: Event) => iframe && e.target === iframe && surCharge();
    document.addEventListener("DOMFrameContentLoaded", charge, true);
    return () => document.removeEventListener("DOMFrameContentLoaded", charge, true);
  });
</script>

<svelte:window onmessage={surMessage} onfocusin={surFocusin} onblur={surBlur} />

<div class="contenu" bind:clientWidth={largeur} bind:clientHeight={hauteur}>
  {#if widget.src}
    <!-- Without allow-same-origin: the code written by the agent runs in an opaque origin, with no access to the interface. -->
    <iframe bind:this={iframe} src={widget.src} title={widget.nom} sandbox="allow-scripts"></iframe>
  {:else}
    <p class="vide">L'agent n'a pas encore écrit l'affichage de ce widget.</p>
  {/if}
</div>

<style>
  .contenu { flex: 1; min-height: 0; display: flex; }
  /* The card background while loading: no white flash in dark mode. */
  iframe { flex: 1; width: 100%; height: 100%; border: none; background: var(--accueil-carte); }
  .vide { margin: 0; padding: 8px 12px; font-size: 12px; color: var(--accueil-texte-doux); }
</style>
