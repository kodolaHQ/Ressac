<script lang="ts">
  import { urlComposant } from "../../commun/actions";

  /**
   * Un composant de l'agent, dans un cadre isolé comme l'affichage d'un widget : sans allow-same-origin, son code tourne
   * dans une origine opaque, sans réseau (CSP du schéma). Il reçoit ses propriétés, le thème et sa largeur par message ;
   * il ne peut que demander sa hauteur (`{ type: "hauteur", px }`), tout autre message est ignoré.
   */
  let { nom, props }: { nom: string; props: Record<string, unknown> } = $props();

  const HAUTEUR_MIN = 20;
  const HAUTEUR_MAX = 2000;
  let iframe = $state<HTMLIFrameElement>();
  let largeur = $state(0);
  let hauteur = $state(150);
  const sombre = matchMedia("(prefers-color-scheme: dark)");
  let theme = $state<"clair" | "sombre">(sombre.matches ? "sombre" : "clair");

  $effect(() => {
    const suivre = () => (theme = sombre.matches ? "sombre" : "clair");
    sombre.addEventListener("change", suivre);
    return () => sombre.removeEventListener("change", suivre);
  });

  function envoyer() {
    // Origine opaque : « * » est la seule cible possible.
    iframe?.contentWindow?.postMessage({ type: "composant", props: $state.snapshot(props), theme, largeur }, "*");
  }
  // À chaque changement (le chargement passe par onload).
  $effect(() => {
    void [props, theme, largeur];
    envoyer();
  });

  function surMessage(e: MessageEvent) {
    if (!iframe || e.source !== iframe.contentWindow) return;
    const d: unknown = e.data;
    if (typeof d !== "object" || d === null) return;
    const { type, px } = d as { type?: unknown; px?: unknown };
    if (type !== "hauteur" || typeof px !== "number" || !Number.isFinite(px)) return;
    hauteur = Math.round(Math.min(HAUTEUR_MAX, Math.max(HAUTEUR_MIN, px)));
  }
</script>

<svelte:window onmessage={surMessage} />

<div data-testid="bloc-{nom}" bind:clientWidth={largeur}>
  <iframe
    bind:this={iframe}
    class="pa-composant"
    data-testid="cadre-composant"
    title={nom}
    src={urlComposant(nom)}
    sandbox="allow-scripts"
    style:height="{hauteur}px"
    onload={envoyer}
  ></iframe>
</div>
