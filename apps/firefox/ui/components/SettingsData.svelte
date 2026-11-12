<script lang="ts">
  import { fade } from "svelte/transition";
  import type { Backup } from "../../shared/settings";
  import { api } from "../state.svelte";
  import BrowserImport from "./BrowserImport.svelte";

  // Styles come from Settings.svelte.
  const s = api.settings;
  const dir = s.dataDir();
  /** null: being measured (du over big backups takes seconds). */
  let backups = $state<Backup[] | null>(null);
  /** A backup to delete, or the reset, awaiting confirmation. */
  let asking = $state<{ backup: string } | "reset" | null>(null);
  let exporting = $state(false);
  let importing = $state(false);
  let message = $state<string | null>(null);
  const load = async () => (backups = await s.backups());
  $effect(() => void load());

  const RESET =
    "Réinitialiser WebAiOs ? Ses données (espaces, onglets, historique, réglages, données des widgets et des actions, installation de Kev (IA locale, à réinstaller)) sont mises de côté dans une sauvegarde, puis WebAiOs redémarre à neuf. Restent en place : le dossier workspace (vos projets et ce que l'agent a créé), les connexions de Claude et de Codex (boutons Se déconnecter, section Agents), la clé de l'API compatible de Codex (Trousseau macOS), les cookies et mots de passe du navigateur (Réglages avancés du navigateur).";
  const date = (iso: string) => new Date(iso).toLocaleString("fr-FR", { dateStyle: "medium", timeStyle: "short" });
  const number = (n: number) => n.toLocaleString("fr-FR", { maximumFractionDigits: 1 });
  // shortcut: assumes a macOS home under /Users, display only; take the home from the chrome if another OS ships.
  const notes = `${dir}/workspace/browsing-notes.md`;
  const shownDir = dir.replace(/^\/Users\/[^/]+(?=\/|$)/, "~");
  const size = (b: number) => (b >= 1e9 ? `${number(b / 1e9)} Go` : `${number(b / 1e6)} Mo`);

  async function deleteBackup(path: string) {
    asking = null;
    const r = await s.deleteBackup(path);
    message = r.ok ? null : r.error;
    await load();
  }
  async function exportData() {
    exporting = true;
    message = null;
    const r = await s.exportData();
    exporting = false;
    message = r.ok ? `Exporté dans ${r.path}` : r.error;
  }
  async function reset() {
    asking = null;
    if (!(await s.reset())) message = "Redémarrage annulé : rien n'a été réinitialisé.";
  }
</script>

<section data-testid="settings-data">
  <h2>Données</h2>
  <div class="panel">
    <div class="row">
      <div class="grow"><b>Dossier</b><code class="muted" data-testid="data-dir" title={dir}>{shownDir}</code></div>
      <button data-testid="data-reveal" onclick={() => s.reveal(dir)}>Afficher dans le Finder</button>
    </div>
    <div class="row">
      <div class="grow"><b>Carnet de recherche</b><span class="muted">Les leçons que l'agent tire de ses recherches : vous pouvez le lire et le corriger.</span></div>
      <button data-testid="settings-browsing-notes" onclick={() => s.reveal(notes)}>Afficher dans le Finder</button>
    </div>
  </div>
  <h3>Importer</h3>
  {#if importing}
    <div class="panel import"><BrowserImport /></div>
  {:else}
    <div class="buttons start" out:fade={{ duration: 150 }}><button data-testid="data-import" onclick={() => (importing = true)}>Importer depuis un autre navigateur</button></div>
  {/if}
  <h3>Sauvegardes</h3>
  {#if !backups}
    <p><span class="pill" data-tone="warn">Vérification…</span></p>
  {:else}
    <div class="panel">
      {#each backups as b (b.path)}
        <div data-testid="backup-row">
          <div class="row">
            <div class="grow">
              <b>{date(b.date)}</b>
              <span class="muted">{size(b.bytes)}</span>
            </div>
            <button data-testid="backup-reveal" onclick={() => s.reveal(b.path)}>Afficher dans le Finder</button>
            <button class="danger" data-testid="backup-delete" onclick={() => (asking = { backup: b.path })}>Supprimer</button>
          </div>
          {#if typeof asking === "object" && asking?.backup === b.path}
            {@const path = b.path}
            <div class="confirmation" role="alertdialog" aria-label="Supprimer la sauvegarde">
              <p>Supprimer définitivement cette sauvegarde ?</p>
              <div class="buttons">
                <button onclick={() => (asking = null)}>Annuler</button>
                <button class="primary" data-testid="confirm-data" onclick={() => void deleteBackup(path)}>Supprimer</button>
              </div>
            </div>
          {/if}
        </div>
      {:else}
        <div class="row muted">Aucune sauvegarde.</div>
      {/each}
    </div>
  {/if}
  {#if message}<p role="status">{message}</p>{/if}
  <div class="buttons start">
    <button class="primary" data-testid="data-export" disabled={exporting} onclick={() => void exportData()}>Exporter</button>
    <button class="danger" data-testid="data-reset" onclick={() => (asking = "reset")}>Réinitialiser</button>
  </div>
  {#if asking === "reset"}
    <div class="confirmation" role="alertdialog" aria-label="Réinitialiser">
      <p>{RESET}</p>
      <div class="buttons">
        <button onclick={() => (asking = null)}>Annuler</button>
        <button class="primary" data-testid="confirm-reset" onclick={() => void reset()}>Réinitialiser et redémarrer</button>
      </div>
    </div>
  {/if}
</section>

<style>
  .import { padding: 14px; animation: webaios-rise var(--spring-d) var(--spring) backwards; }
</style>
