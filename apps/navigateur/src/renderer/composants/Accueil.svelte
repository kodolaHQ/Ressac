<script lang="ts">
  import type { Placement, WidgetAffiche } from "../../commun/api";
  import { api } from "../etat.svelte";
  import { COLONNES, deplacer, ECART_PX, RANGEE_PX, redimensionner, versCase, type Tailles } from "../grille";
  import CarteAccordCompte from "./CarteAccordCompte.svelte";
  import WidgetAccueil from "./WidgetAccueil.svelte";

  /** Délai au-delà duquel une action sans aucun changement de la page est signalée (service des widgets absent…). */
  const DELAI_SANS_EFFET_MS = 6000;
  const SANS_EFFET = "Sans effet pour l'instant : le service des widgets ne répond pas (agent arrêté ?).";
  const TAILLES_LIBRES: Tailles = { min: { l: 1, h: 1 }, max: { l: COLONNES, h: COLONNES } };

  // Remplacée d'un bloc à chaque lecture : pas de proxy profond (les données partent telles quelles vers les cadres).
  let widgets = $state.raw<WidgetAffiche[]>([]);
  // Lectures qui se croisent (rafale de changements) : seule la dernière compte.
  let derniere = 0;
  function charger() {
    const n = ++derniere;
    api.accueil.lire().then(
      (w) => n === derniere && (widgets = w),
      () => {},
    );
  }
  $effect(() => {
    charger();
    return api.accueil.surChange(() => {
      // Le service a répondu : les actions en attente ont eu un effet.
      for (const t of attentes.values()) clearTimeout(t);
      attentes.clear();
      avertissements = {};
      charger();
    });
  });

  /** Actions envoyées sans réponse possible (accorder, refuser, mettre à jour) : un avertissement si rien ne bouge. */
  const attentes = new Map<string, ReturnType<typeof setTimeout>>();
  let avertissements = $state<Record<string, string>>({});
  function agir(id: string, action: () => void) {
    try {
      action();
    } catch {
      avertissements = { ...avertissements, [id]: SANS_EFFET };
      return;
    }
    clearTimeout(attentes.get(id));
    attentes.set(
      id,
      setTimeout(() => {
        attentes.delete(id);
        avertissements = { ...avertissements, [id]: SANS_EFFET };
      }, DELAI_SANS_EFFET_MS),
    );
  }
  $effect(() => () => {
    for (const t of attentes.values()) clearTimeout(t);
  });

  /** Widgets dont l'utilisateur a refusé la lecture avec son compte, pendant cette session de la page. */
  let refuses = $state<Record<string, true>>({});
  let aRetirer = $state<WidgetAffiche | null>(null);
  let accordPour = $state<Extract<WidgetAffiche, { compte: string[] }> | null>(null);
  const nom = (w: WidgetAffiche) => ("nom" in w ? w.nom : w.id);

  // Glisser et redimensionner : un aperçu en direct, puis la disposition envoyée au relâchement.
  let largeurGrille = $state(0);
  const largeurColonne = $derived(Math.max(1, (largeurGrille - (COLONNES - 1) * ECART_PX) / COLONNES));
  let geste: { id: string; mode: "deplacer" | "taille"; x0: number; y0: number; depart: Placement[]; p0: Placement; tailles: Tailles } | null = null;
  let enGeste = $state(false);
  let apercu = $state.raw<Placement[] | null>(null);
  const placements = $derived(new Map((apercu ?? widgets.map((w) => w.placement)).map((p) => [p.id, p])));

  function commencer(w: WidgetAffiche, mode: "deplacer" | "taille", e: PointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    const depart = widgets.map((x) => x.placement);
    const p0 = depart.find((p) => p.id === w.id);
    if (!p0) return;
    geste = { id: w.id, mode, x0: e.clientX, y0: e.clientY, depart, p0, tailles: "tailles" in w ? w.tailles : TAILLES_LIBRES };
    enGeste = true;
    apercu = depart;
  }
  function bouger(e: PointerEvent) {
    if (!geste) return;
    const { id, mode, depart, p0, tailles } = geste;
    const dx = versCase(e.clientX - geste.x0, largeurColonne);
    const dy = versCase(e.clientY - geste.y0, RANGEE_PX);
    apercu = mode === "deplacer" ? deplacer(depart, id, p0.x + dx, p0.y + dy) : redimensionner(depart, id, p0.l + dx, p0.h + dy, tailles);
  }
  function finir(annule: boolean) {
    if (!geste) return;
    const { depart } = geste;
    const final = apercu;
    geste = null;
    enGeste = false;
    apercu = null;
    if (annule || !final) return;
    const change = final.some((p, i) => {
      const a = depart[i]!;
      return p.x !== a.x || p.y !== a.y || p.l !== a.l || p.h !== a.h;
    });
    if (!change) return;
    // Tout de suite à l'écran ; la surveillance du dossier confirmera.
    const parId = new Map(final.map((p) => [p.id, p]));
    widgets = widgets.map((w) => ({ ...w, placement: parId.get(w.id) ?? w.placement }));
    api.accueil.placer(final);
  }
</script>

<svelte:window onpointermove={bouger} onpointerup={() => finir(false)} onpointercancel={() => finir(true)} />

{#if widgets.length}
  <section class="grille" class:geste={enGeste} data-testid="accueil" bind:clientWidth={largeurGrille}>
    {#each widgets as widget (widget.id)}
      {@const p = placements.get(widget.id) ?? widget.placement}
      <div class="case" style:grid-column="{p.x + 1} / span {p.l}" style:grid-row="{p.y + 1} / span {p.h}">
        <WidgetAccueil
          {widget}
          placement={p}
          geste={enGeste}
          avertissement={avertissements[widget.id] ?? null}
          refuse={!!refuses[widget.id]}
          commencer={(mode, e) => commencer(widget, mode, e)}
          retirer={() => (aRetirer = widget)}
          autoriser={() => "compte" in widget && (accordPour = widget)}
          refuser={() => {
            refuses = { ...refuses, [widget.id]: true };
            agir(widget.id, () => api.accueil.refuserAccord(widget.id));
          }}
          recolter={() => agir(widget.id, () => api.accueil.recolter(widget.id))}
        />
      </div>
    {/each}
  </section>
{/if}

{#if accordPour}
  {@const cible = accordPour}
  <CarteAccordCompte
    nom={cible.nom}
    domaines={cible.compte}
    fermer={() => (accordPour = null)}
    autoriser={(profil) => {
      const id = cible.id; // {@const} se relit : après accordPour = null, cible vaut null
      accordPour = null;
      const { [id]: _, ...reste } = refuses;
      refuses = reste;
      agir(id, () => api.accueil.accorder(id, profil));
    }}
  />
{/if}

{#if aRetirer}
  {@const cible = aRetirer}
  <div class="voile">
    <div class="confirmation" role="alertdialog" aria-modal="true" data-testid="confirmation-retrait">
      <p>Retirer « {nom(cible)} » de la page d'accueil ?</p>
      <div class="boutons">
        <button onclick={() => (aRetirer = null)}>Annuler</button>
        <button
          class="principal"
          onclick={() => {
            const id = cible.id; // {@const} se relit : après aRetirer = null, cible vaut null
            aRetirer = null;
            widgets = widgets.filter((w) => w.id !== id);
            api.accueil.retirer(id);
          }}>Retirer</button
        >
      </div>
    </div>
  </div>
{/if}

<style>
  .grille {
    width: min(1200px, 94%);
    display: grid;
    grid-template-columns: repeat(12, minmax(0, 1fr));
    grid-auto-rows: 90px;
    gap: 12px;
    padding-bottom: 32px;
  }
  .case { min-width: 0; min-height: 0; }
  .grille.geste { user-select: none; }
  /* Pendant un geste, les cadres des widgets ne doivent pas capter la souris. */
  .grille.geste :global(iframe) { pointer-events: none; }
  .voile { position: fixed; inset: 0; display: grid; place-content: center; background: rgb(0 0 0 / 0.35); z-index: 10; }
  .confirmation { padding: 16px 20px; border-radius: 10px; background: var(--fond-barre); border: 1px solid var(--bord); color: var(--texte); }
  .confirmation p { margin: 0 0 14px; }
  .boutons { display: flex; justify-content: flex-end; gap: 8px; }
  .boutons button { padding: 6px 12px; border-radius: 6px; border: 1px solid var(--bord); background: var(--fond); color: var(--texte); }
  .boutons .principal { background: var(--accent); border-color: var(--accent); color: white; }
</style>
