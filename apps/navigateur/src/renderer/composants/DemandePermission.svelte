<script lang="ts">
  import type { DemandeEnAttente, Permission } from "../../commun/modele";
  import { api } from "../etat.svelte";

  let { demande }: { demande: DemandeEnAttente } = $props();

  const NOMS: Record<Permission, string> = {
    "media-camera": "votre caméra",
    "media-micro": "votre micro",
    notifications: "vous envoyer des notifications",
    geolocation: "connaître votre position",
    fullscreen: "passer en plein écran",
    "clipboard-sanitized-write": "écrire dans le presse-papiers",
    "ouvrir-application": "ouvrir un lien dans une autre application",
    autre: "une permission inconnue",
  };

  const site = $derived(new URL(demande.origine).host);
  const texte = $derived.by(() => {
    const media = demande.permissions.filter((p) => p.startsWith("media-")).map((p) => NOMS[p]);
    const autres = demande.permissions.filter((p) => !p.startsWith("media-")).map((p) => NOMS[p]);
    const parties = [...(media.length ? [`utiliser ${media.join(" et ")}`] : []), ...autres];
    const texte = `${site} veut ${parties.join(" et ")}`;
    return demande.lien ? `${texte} : ${demande.lien.slice(0, 120)}` : texte;
  });
</script>

<div class="bandeau" data-testid="demande-permission" role="alertdialog" aria-label="Demande d'autorisation">
  <span>{texte}</span>
  <button onclick={() => api.permissions.repondre(demande.id, "refuser")}>Refuser</button>
  <button class="autoriser" onclick={() => api.permissions.repondre(demande.id, "autoriser")}>Autoriser</button>
</div>

<style>
  .bandeau { display: flex; align-items: center; gap: 8px; padding: 8px 12px; background: var(--fond-actif); border-bottom: 1px solid var(--bord); color: var(--texte); }
  span { flex: 1; }
  button { padding: 4px 10px; border-radius: 6px; border: 1px solid var(--bord); background: var(--fond-barre); color: var(--texte); }
  .autoriser { background: var(--accent); border-color: var(--accent); color: white; }
</style>
