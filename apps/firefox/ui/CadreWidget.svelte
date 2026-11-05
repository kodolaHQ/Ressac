<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { api } from "../../navigateur/src/renderer/etat.svelte";

  /**
   * L'affichage d'un widget dans son cadre isolé : sans allow-same-origin, le code écrit par l'agent tourne dans une
   * origine opaque, sans accès à l'interface. Il reçoit ses données par postMessage ; ses liens passent par
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
    // Le cadre a une origine opaque (sandbox sans allow-same-origin) : « * » est la seule cible possible.
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
  // À chaque changement de données, d'état ou de taille (le chargement passe par onload).
  $effect(() => {
    void [donnees, etat.statut, etat.derniereMaj, taille.l, taille.h, largeur, hauteur];
    envoyer();
  });

  // Le widget ne prend le clavier que sous le pointeur (un clic de l'utilisateur) : un focus() de son code est rendu à
  // l'élément de l'interface qui l'avait.
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
    // L'origine d'un cadre sandbox est opaque (« null ») : c'est la source, jamais l'origine, qui l'identifie.
    if (!iframe || e.source !== iframe.contentWindow) return;
    const d: unknown = e.data;
    if (typeof d !== "object" || d === null) return;
    const { type, url } = d as { type?: unknown; url?: unknown };
    if (type !== "ouvrir" || typeof url !== "string") return;
    // Le process principal n'ouvre le lien que si un vrai clic de l'utilisateur vient de tomber dans ce widget (un lien par clic).
    api.accueil.ouvrir(url, widget.id);
  }

  // La garde est un script en tête de la copie servie ; elle retire WebRTC en dernier, donc tant que RTCPeerConnection
  // est là elle n'a pas pu s'installer entièrement : aucun appui n'est alors enregistré (échec fermé). Ce listener est
  // posé par le chrome, que le widget ne peut ni retirer ni imiter (isTrusted).
  let fenetreGeste: Window | null = null;
  function geste(e: PointerEvent) {
    if (e.isTrusted) api.accueil.geste(widget.id);
  }
  // Le lien du widget : `webaiosOuvrir` (fourni par la garde dans le monde de la page) émet cet événement, que le
  // parent chrome écoute (une origine opaque ne peut pas lui poster de message). La demande reste soumise au geste.
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
    const cadre = iframe?.contentWindow;
    if (!cadre) return;
    // wrappedJSObject : le global de la page, où la garde a réellement supprimé WebRTC (un Xray montrerait l'interface native).
    const page = (cadre as unknown as { wrappedJSObject?: { RTCPeerConnection?: unknown; trustedTypes?: unknown } }).wrappedJSObject;
    if (!page || page.RTCPeerConnection !== undefined || page.trustedTypes === undefined) return;
    fenetreGeste = cadre;
    cadre.addEventListener("pointerdown", geste, true);
    cadre.addEventListener("webaios-ouvrir", lien, true);
  }
  onMount(brancherGeste);
  onDestroy(detacherGeste);

  function surCharge() {
    envoyer();
    brancherGeste();
  }
</script>

<svelte:window onmessage={surMessage} onfocusin={surFocusin} onblur={surBlur} />

<div class="contenu" bind:clientWidth={largeur} bind:clientHeight={hauteur}>
  {#if widget.src}
    <!-- Sans allow-same-origin : le code écrit par l'agent tourne dans une origine opaque, sans accès à l'interface. -->
    <iframe bind:this={iframe} src={widget.src} title={widget.nom} sandbox="allow-scripts" onload={surCharge}></iframe>
  {:else}
    <p class="vide">L'agent n'a pas encore écrit l'affichage de ce widget.</p>
  {/if}
</div>

<style>
  .contenu { flex: 1; min-height: 0; display: flex; }
  /* Le fond de la carte pendant le chargement : plus de flash blanc en mode sombre. */
  iframe { flex: 1; width: 100%; height: 100%; border: none; background: var(--accueil-carte); }
  .vide { margin: 0; padding: 8px 12px; font-size: 12px; color: var(--accueil-texte-doux); }
</style>
