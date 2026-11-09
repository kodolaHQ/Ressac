<script lang="ts">
  import type { ApiDesign, ElementAffiche, LotAffiche } from "../../shared/api";

  /** Le panier d'un projet : ses remarques, et l'envoi à sa destination. */
  let {
    api,
    projet,
    destination,
    sansDestination,
    fermer,
  }: {
    api: Pick<ApiDesign, "panier" | "retirer" | "envoyer" | "lots" | "traite" | "surChange">;
    projet: string;
    destination: string | null;
    sansDestination: string | null;
    fermer?: () => void;
  } = $props();

  let elements = $state<ElementAffiche[]>([]);
  let erreur = $state<string | null>(null);
  let envoi = $state(false);
  let lots = $state<LotAffiche[]>([]);
  let requete = 0;

  async function relire() {
    const n = ++requete;
    const p = projet;
    const [liste, envoyes] = await Promise.all([api.panier(p).catch(() => []), api.lots(p).catch(() => [])]);
    if (n === requete) {
      elements = liste;
      lots = envoyes;
    }
  }

  const ETATS = { "en-attente": "en attente", lu: "lu", traite: "traité" } as const;
  const heure = (iso: string) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? "" : d.toLocaleString("fr-FR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  };
  const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
  async function marquerTraite(lot: string) {
    erreur = null;
    try {
      await api.traite(projet, lot);
    } catch (e) {
      erreur = message(e);
    }
    void relire();
  }

  $effect(() => {
    void projet;
    void relire();
    return api.surChange(() => void relire());
  });

  const n = $derived(elements.length);
  const libelle = $derived(`Envoyer ${n} remarque${n > 1 ? "s" : ""} à ${destination ?? "…"}`);

  async function envoyer() {
    envoi = true;
    erreur = null;
    try {
      const r = await api.envoyer(projet);
      if (!r.ok) erreur = r.erreur;
    } catch (e) {
      erreur = message(e);
    } finally {
      envoi = false;
    }
    void relire();
  }

  const debut = (t: string) => (t.length > 120 ? `${t.slice(0, 120)}…` : t);
</script>

<aside class="panier" data-testid="panier-design" aria-label="Panier du mode design">
  <header>
    <h2>Panier</h2>
    {#if fermer}<button class="fermer" aria-label="Fermer le panier" onclick={fermer}>×</button>{/if}
  </header>
  {#if n === 0}
    <p class="vide">Aucune remarque. Clique un élément de la page pour en écrire une.</p>
  {:else}
    <ul>
      {#each elements as e (e.id)}
        <li data-testid="remarque-panier">
          <div class="tete">
            <code class="etiquette">{e.etiquette}</code>
            <button class="supprimer" aria-label="Supprimer" onclick={() => void api.retirer(projet, e.id)}>×</button>
          </div>
          <p class="texte">{debut(e.texte)}</p>
          {#if e.source}<p class="source">{e.source}</p>{/if}
        </li>
      {/each}
    </ul>
  {/if}
  {#if lots.length > 0}
    <section class="envoyes" aria-label="Lots envoyés">
      <h3>Envoyés</h3>
      <ul>
        {#each lots as l (l.id)}
          <li data-testid="lot-envoye" data-etat={l.etat}>
            <div class="tete">
              <span class="etat">{ETATS[l.etat]}</span>
              <span class="quand">{heure(l.cree)} · {l.destination === "agent" ? "agent" : "Claude Code"} · {l.elements.length}</span>
              {#if l.destination === "agent" && l.etat !== "traite"}
                <button class="traite" onclick={() => void marquerTraite(l.id)}>Traité</button>
              {/if}
            </div>
            {#each l.elements as e (e.id)}
              <p class="sous"><code class="etiquette">{e.etiquette}</code> {debut(e.texte)}</p>
              {#if e.traite?.note}<p class="note">{e.traite.note}</p>{/if}
            {/each}
          </li>
        {/each}
      </ul>
    </section>
  {/if}
  <footer>
    {#if destination === null && sansDestination}<p class="raison">{sansDestination}</p>{/if}
    {#if erreur}<p class="raison" role="alert">{erreur}</p>{/if}
    <button class="envoyer" data-testid="envoyer-remarques" disabled={n === 0 || destination === null || envoi} onclick={envoyer}>{libelle}</button>
  </footer>
</aside>

<style>
  .panier { display: flex; flex-direction: column; height: 100%; box-sizing: border-box; padding: 10px; gap: 8px; background: var(--fond-barre); color: var(--texte); border-left: 1px solid var(--bord); font-size: 13px; }
  header { display: flex; align-items: center; justify-content: space-between; }
  h2 { margin: 0; font-size: 14px; }
  ul { list-style: none; margin: 0; padding: 0; overflow: auto; flex: 1; display: flex; flex-direction: column; gap: 6px; }
  li { background: var(--fond); border: 1px solid var(--bord); border-radius: 6px; padding: 6px 8px; }
  .tete { display: flex; align-items: center; gap: 6px; }
  .etiquette { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--accent); font-size: 12px; }
  .texte { margin: 4px 0 0; white-space: pre-wrap; word-break: break-word; }
  .source { margin: 2px 0 0; color: var(--texte-doux); font-size: 11px; word-break: break-all; }
  .envoyes { max-height: 40%; overflow: auto; display: flex; flex-direction: column; gap: 4px; }
  .envoyes ul { flex: none; overflow: visible; }
  h3 { margin: 0; font-size: 12px; color: var(--texte-doux); font-weight: 600; }
  .etat { font-weight: 600; font-size: 12px; }
  .quand { flex: 1; color: var(--texte-doux); font-size: 11px; }
  .traite { padding: 2px 8px; border-radius: 4px; background: var(--fond-survol); font-size: 12px; }
  .sous { margin: 4px 0 0; font-size: 12px; word-break: break-word; }
  .note { margin: 2px 0 0 8px; font-size: 12px; color: var(--texte-doux); border-left: 2px solid var(--bord); padding-left: 6px; white-space: pre-wrap; word-break: break-word; }
  .vide { color: var(--texte-doux); flex: 1; margin: 0; }
  .raison { color: var(--en-cours); margin: 0 0 6px; font-size: 12px; }
  button { all: unset; cursor: pointer; }
  .fermer, .supprimer { width: 20px; height: 20px; display: grid; place-content: center; border-radius: 4px; color: var(--texte-doux); }
  .fermer:hover, .supprimer:hover { background: var(--fond-survol); color: var(--texte); }
  .envoyer { display: block; box-sizing: border-box; width: 100%; text-align: center; padding: 7px 10px; border-radius: 6px; background: var(--accent); color: #fff; font-weight: 600; }
  .envoyer:disabled { opacity: 0.4; cursor: default; }
</style>
