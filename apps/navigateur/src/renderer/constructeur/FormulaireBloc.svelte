<script lang="ts">
  import { untrack } from "svelte";
  import type { CatalogueBloc } from "@webaios/noyau";
  import { regler, renommer, type Brouillon } from "./brouillon";
  import type { Edition } from "./edition.svelte";
  import { champsAffiches, entreeDe, parametresAvec, texteDe, type ChampFormulaire } from "./formulaire";

  type BlocBrouillon = Brouillon["blocs"][number];

  /**
   * Les réglages d'un bloc, tirés de son catalogue. Une case ou une liste de choix s'enregistre aussitôt ; un champ de
   * texte à la perte du focus ou après 400 ms sans frappe, en une seule entrée d'historique par champ édité.
   * Sans geste de l'utilisateur, rien n'est écrit (sélectionner un bloc n'enregistre rien).
   */
  let { edition, bloc, catalogue, disponibles }: { edition: Edition; bloc: BlocBrouillon; catalogue: CatalogueBloc; disponibles: string[] | null } =
    $props();

  const NOM = "#nom";
  const ATTENTE_MS = 400;
  // svelte-ignore state_referenced_locally
  const id = bloc.id;

  const champs = $derived(champsAffiches(catalogue, bloc.parametres));
  /** Texte des champs en cours d'édition (focus) ; les autres montrent la valeur du bloc. */
  let saisies = $state<Record<string, string>>({});
  /** Texte au moment du focus : un champ quitté sans changement n'écrit rien. */
  const initiales: Record<string, string> = {};
  const seances: Record<string, number> = {};
  let seance = 0;
  const minuteries = new Map<string, ReturnType<typeof setTimeout>>();

  function valider(nom: string): void {
    clearTimeout(minuteries.get(nom));
    minuteries.delete(nom);
    const t = saisies[nom];
    if (t === undefined || t === initiales[nom]) return;
    const fusion = `${id}/${nom}/${seances[nom]}`;
    if (nom === NOM) {
      edition.modifier((b) => renommer(b, id, t.trim()), fusion);
      return;
    }
    const f = catalogue.champs.find((c) => c.nom === nom);
    if (!f) return;
    edition.modifier((b) => {
      const x = b.blocs.find((y) => y.id === id);
      const p = x && parametresAvec(x.parametres, f, t);
      return p ? regler(b, id, p) : b;
    }, fusion);
  }

  function entrer(nom: string, texte: string): void {
    seances[nom] = ++seance;
    initiales[nom] = texte;
    saisies[nom] = texte;
  }
  function taper(nom: string, texte: string): void {
    if (saisies[nom] === undefined) entrer(nom, texte);
    saisies[nom] = texte;
    clearTimeout(minuteries.get(nom));
    minuteries.set(nom, setTimeout(() => valider(nom), ATTENTE_MS));
  }
  function quitter(nom: string): void {
    valider(nom);
    delete saisies[nom];
  }

  /** Case ou liste de choix : enregistrée aussitôt. */
  function choisir(f: ChampFormulaire, v: string | boolean): void {
    edition.modifier((b) => {
      const x = b.blocs.find((y) => y.id === id);
      const p = x && parametresAvec(x.parametres, f, v);
      return p ? regler(b, id, p) : b;
    });
  }

  // Le bloc change ou l'onglet se ferme pendant une frappe : elle est enregistrée, pas perdue.
  $effect(() => () => untrack(() => [...minuteries.keys()].forEach(valider)));

  const texteChamp = (f: ChampFormulaire) => saisies[f.nom] ?? texteDe(f, bloc.parametres[f.nom]);
</script>

<div class="formulaire">
  <label class="champ">
    <span class="libelle">Nom</span>
    <input
      data-testid="nom-bloc"
      value={saisies[NOM] ?? bloc.nom ?? ""}
      placeholder={id}
      maxlength="60"
      onfocus={(e) => entrer(NOM, e.currentTarget.value)}
      oninput={(e) => taper(NOM, e.currentTarget.value)}
      onblur={() => quitter(NOM)}
    />
  </label>
  <div class="champ">
    <span class="libelle">Identifiant</span>
    <code data-testid="id-bloc">{id}</code>
  </div>

  {#each champs as f (f.nom)}
    {#if f.genre === "case"}
      <label class="champ case">
        <input
          type="checkbox"
          data-testid="champ-{f.nom}"
          checked={entreeDe(f, bloc.parametres) === true}
          onchange={(e) => choisir(f, e.currentTarget.checked)}
        />
        <span class="libelle">{f.libelle}</span>
      </label>
    {:else if f.genre === "choix"}
      {@const v = bloc.parametres[f.nom]}
      <label class="champ">
        <span class="libelle">{f.libelle}{f.requis ? " *" : ""}</span>
        <select data-testid="champ-{f.nom}" value={typeof v === "string" ? v : ""} onchange={(e) => choisir(f, e.currentTarget.value)}>
          {#if !f.requis}<option value="">Par défaut{f.defaut === undefined ? "" : ` (${texteDe(f, f.defaut)})`}</option>{/if}
          {#each f.choix ?? [] as c (c)}<option value={c}>{c}</option>{/each}
          {#if typeof v === "string" && v !== "" && !(f.choix ?? []).includes(v)}<option value={v}>{v}</option>{/if}
        </select>
      </label>
    {:else}
      <label class="champ">
        <span class="libelle">
          {f.libelle}{f.requis ? " *" : ""}
          {#if f.genre === "gabarit"}<span class="marque" title="Les {'{chemins}'} sont remplacés par les valeurs reçues">gabarit</span>{/if}
        </span>
        {#if f.genre === "nombre"}
          <input
            type="number"
            data-testid="champ-{f.nom}"
            min={f.min}
            max={f.max}
            step={f.entier ? 1 : "any"}
            value={texteChamp(f)}
            placeholder={texteDe(f, f.defaut)}
            onfocus={(e) => entrer(f.nom, e.currentTarget.value)}
            oninput={(e) => {
              // « 0. » en cours de frappe se lit comme vide : la clé ne doit pas partir pour autant.
              if (!e.currentTarget.validity.badInput) taper(f.nom, e.currentTarget.value);
            }}
            onblur={() => quitter(f.nom)}
          />
        {:else if f.genre === "texte"}
          <input
            data-testid="champ-{f.nom}"
            value={texteChamp(f)}
            placeholder={texteDe(f, f.defaut)}
            spellcheck="false"
            onfocus={(e) => entrer(f.nom, e.currentTarget.value)}
            oninput={(e) => taper(f.nom, e.currentTarget.value)}
            onblur={() => quitter(f.nom)}
          />
        {:else}
          <textarea
            data-testid="champ-{f.nom}"
            rows={f.genre === "textes" ? 3 : 2}
            value={texteChamp(f)}
            placeholder={f.genre === "textes" ? "Une valeur par ligne" : texteDe(f, f.defaut)}
            spellcheck="false"
            onfocus={(e) => entrer(f.nom, e.currentTarget.value)}
            oninput={(e) => taper(f.nom, e.currentTarget.value)}
            onblur={() => quitter(f.nom)}
          ></textarea>
        {/if}
      </label>
      {#if f.genre === "gabarit" && disponibles && disponibles.length > 0}
        <p class="aide" data-testid="disponibles-{f.nom}">Champs disponibles : {disponibles.map((c) => `{${c}}`).join(" ")}</p>
      {/if}
    {/if}
    {#if f.aide}<p class="aide">{f.aide}</p>{/if}
  {/each}
</div>

<style>
  .formulaire { display: flex; flex-direction: column; gap: 4px; }
  .champ { display: flex; flex-direction: column; gap: 3px; margin-top: 6px; font-size: 12px; }
  .champ.case { flex-direction: row; align-items: center; gap: 6px; }
  .libelle { color: var(--texte-doux); display: flex; align-items: center; gap: 6px; }
  .marque { font-size: 10px; padding: 0 5px; border-radius: 4px; background: var(--fond-actif); color: var(--texte); }
  input:not([type="checkbox"]), select, textarea {
    box-sizing: border-box; width: 100%; padding: 5px 7px; border-radius: 6px; border: 1px solid var(--bord);
    background: var(--fond); color: var(--texte); font: inherit; font-size: 12px;
  }
  textarea { resize: vertical; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  code { font-size: 12px; color: var(--texte); word-break: break-all; }
  .aide { margin: 0; font-size: 11px; color: var(--texte-doux); word-break: break-word; }
</style>
