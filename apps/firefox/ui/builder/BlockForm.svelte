<script lang="ts">
  import { untrack } from "svelte";
  import type { CatalogueBloc } from "@webaios/kernel";
  import { set, rename, type Brouillon } from "./draft";
  import type { Edition } from "./edition.svelte";
  import { shownFields, entreeDe, paramsWith, textOf, type FormField } from "./form";

  type DraftBlock = Brouillon["blocs"][number];

  /**
   * A block's settings, drawn from its catalog. A checkbox or a choice list saves right away; a text field on focus
   * loss or after 400 ms without typing; a number on focus loss or on Enter only (a transient value like « 0. » would
   * erase the block's memory). A single history entry per edited field.
   * Without a gesture from the user, nothing is written (selecting a block saves nothing).
   */
  let { edition, bloc, catalogue, disponibles: available }: { edition: Edition; bloc: DraftBlock; catalogue: CatalogueBloc; disponibles: string[] | null } =
    $props();

  const NAME = "#nom";
  const WAIT_MS = 400;
  // svelte-ignore state_referenced_locally
  const id = bloc.id;

  const champs = $derived(shownFields(catalogue, bloc.parametres));
  /** Text of the fields being edited (focus); the others show the block's value. */
  let inputs = $state<Record<string, string>>({});
  /** Text at focus, then at the last save: a field left unchanged writes nothing. */
  const initial: Record<string, string> = {};
  const seances: Record<string, number> = {};
  let seance = 0;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  function validate(name: string): void {
    clearTimeout(timers.get(name));
    timers.delete(name);
    const t = inputs[name];
    if (t === undefined || t === initial[name]) return;
    // Going back to the previous value afterwards is a change, which is saved.
    initial[name] = t;
    const fusion = `${id}/${name}/${seances[name]}`;
    if (name === NAME) {
      edition.modifier((b) => rename(b, id, t.trim()), fusion);
      return;
    }
    const f = catalogue.champs.find((c) => c.nom === name);
    if (!f) return;
    edition.modifier((b) => {
      const x = b.blocs.find((y) => y.id === id);
      const p = x && paramsWith(x.parametres, f, t);
      return p ? set(b, id, p) : b;
    }, fusion);
  }

  function enter(name: string, text: string): void {
    seances[name] = ++seance;
    initial[name] = text;
    inputs[name] = text;
  }
  function taper(name: string, text: string): void {
    if (inputs[name] === undefined) enter(name, text);
    inputs[name] = text;
    clearTimeout(timers.get(name));
    timers.set(name, setTimeout(() => validate(name), WAIT_MS));
  }
  /** Number: the input is held, saved only on focus loss or on Enter. */
  function noter(name: string, text: string): void {
    if (inputs[name] === undefined) enter(name, text);
    inputs[name] = text;
  }
  function quitter(name: string): void {
    validate(name);
    delete inputs[name];
  }

  /** Checkbox or choice list: saved right away. */
  function choose(f: FormField, v: string | boolean): void {
    edition.modifier((b) => {
      const x = b.blocs.find((y) => y.id === id);
      const p = x && paramsWith(x.parametres, f, v);
      return p ? set(b, id, p) : b;
    });
  }

  // The block changes or the tab closes during typing: it is saved, not lost.
  $effect(() => () => untrack(() => [...timers.keys()].forEach(validate)));

  const fieldText = (f: FormField) => inputs[f.nom] ?? textOf(f, bloc.parametres[f.nom]);
</script>

<div class="formulaire">
  <label class="champ">
    <span class="libelle">Nom</span>
    <input
      data-testid="nom-bloc"
      value={inputs[NAME] ?? bloc.nom ?? ""}
      placeholder={id}
      maxlength="60"
      onfocus={(e) => enter(NAME, e.currentTarget.value)}
      oninput={(e) => taper(NAME, e.currentTarget.value)}
      onblur={() => quitter(NAME)}
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
          onchange={(e) => choose(f, e.currentTarget.checked)}
        />
        <span class="libelle">{f.libelle}</span>
      </label>
    {:else if f.genre === "choix"}
      {@const v = bloc.parametres[f.nom]}
      <label class="champ">
        <span class="libelle">{f.libelle}{f.requis ? " *" : ""}</span>
        <select data-testid="champ-{f.nom}" value={typeof v === "string" ? v : ""} onchange={(e) => choose(f, e.currentTarget.value)}>
          {#if f.requis && typeof v !== "string"}<option value="" disabled>— choisir —</option>{/if}
          {#if !f.requis}<option value="">Par défaut{f.defaut === undefined ? "" : ` (${textOf(f, f.defaut)})`}</option>{/if}
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
            value={fieldText(f)}
            placeholder={textOf(f, f.defaut)}
            onfocus={(e) => enter(f.nom, e.currentTarget.value)}
            oninput={(e) => {
              // An unreadable input (« - ») reads as empty: the key must not go out for that.
              if (!e.currentTarget.validity.badInput) noter(f.nom, e.currentTarget.value);
            }}
            onkeydown={(e) => e.key === "Enter" && validate(f.nom)}
            onblur={(e) => {
              quitter(f.nom);
              // Still unreadable: the field shows the block's value again.
              if (e.currentTarget.validity.badInput) e.currentTarget.value = textOf(f, bloc.parametres[f.nom]);
            }}
          />
        {:else if f.genre === "texte"}
          <input
            data-testid="champ-{f.nom}"
            value={fieldText(f)}
            placeholder={textOf(f, f.defaut)}
            spellcheck="false"
            onfocus={(e) => enter(f.nom, e.currentTarget.value)}
            oninput={(e) => taper(f.nom, e.currentTarget.value)}
            onblur={() => quitter(f.nom)}
          />
        {:else}
          <textarea
            data-testid="champ-{f.nom}"
            rows={f.genre === "textes" ? 3 : 2}
            value={fieldText(f)}
            placeholder={f.genre === "textes" ? "Une valeur par ligne" : textOf(f, f.defaut)}
            spellcheck="false"
            onfocus={(e) => enter(f.nom, e.currentTarget.value)}
            oninput={(e) => taper(f.nom, e.currentTarget.value)}
            onblur={() => quitter(f.nom)}
          ></textarea>
        {/if}
      </label>
      {#if f.genre === "gabarit" && available && available.length > 0}
        <p class="aide" data-testid="disponibles-{f.nom}">Champs disponibles : {available.map((c) => `{${c}}`).join(" ")}</p>
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
