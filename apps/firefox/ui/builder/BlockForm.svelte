<script lang="ts">
  import { untrack } from "svelte";
  import type { BlockCatalogEntry } from "@webaios/kernel";
  import { set, rename, type Draft } from "./draft";
  import type { Edit } from "./edit.svelte";
  import { shownFields, entryOf, paramsWith, textOf, type FormField } from "./form";

  type DraftBlock = Draft["blocks"][number];

  /**
   * A block's settings, drawn from its catalog. A checkbox or a choice list saves right away; a text field on focus
   * loss or after 400 ms without typing; a number on focus loss or on Enter only (a transient value like « 0. » would
   * erase the block's memory). A single history entry per edited field.
   * Without a gesture from the user, nothing is written (selecting a block saves nothing).
   */
  let { editing: edit, block: block, catalog: catalog, available: available }: { editing: Edit; block: DraftBlock; catalog: BlockCatalogEntry; available: string[] | null } =
    $props();

  const NAME = "#nom";
  const WAIT_MS = 400;
  // svelte-ignore state_referenced_locally
  const id = block.id;

  const fieldList = $derived(shownFields(catalog, block.params));
  /** Text of the fields being edited (focus); the others show the block's value. */
  let inputs = $state<Record<string, string>>({});
  /** Text at focus, then at the last save: a field left unchanged writes nothing. */
  const initial: Record<string, string> = {};
  const sessions: Record<string, number> = {};
  let session = 0;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  function validate(name: string): void {
    clearTimeout(timers.get(name));
    timers.delete(name);
    const t = inputs[name];
    if (t === undefined || t === initial[name]) return;
    // Going back to the previous value afterwards is a change, which is saved.
    initial[name] = t;
    const fusion = `${id}/${name}/${sessions[name]}`;
    if (name === NAME) {
      edit.edit((b) => rename(b, id, t.trim()), fusion);
      return;
    }
    const f = catalog.fields.find((c) => c.name === name);
    if (!f) return;
    edit.edit((b) => {
      const x = b.blocks.find((y) => y.id === id);
      const p = x && paramsWith(x.params, f, t);
      return p ? set(b, id, p) : b;
    }, fusion);
  }

  function enter(name: string, text: string): void {
    sessions[name] = ++session;
    initial[name] = text;
    inputs[name] = text;
  }
  function typeText(name: string, text: string): void {
    if (inputs[name] === undefined) enter(name, text);
    inputs[name] = text;
    clearTimeout(timers.get(name));
    timers.set(name, setTimeout(() => validate(name), WAIT_MS));
  }
  /** Number: the input is held, saved only on focus loss or on Enter. */
  function note(name: string, text: string): void {
    if (inputs[name] === undefined) enter(name, text);
    inputs[name] = text;
  }
  function quit(name: string): void {
    validate(name);
    delete inputs[name];
  }

  /** Checkbox or choice list: saved right away. */
  function choose(f: FormField, v: string | boolean): void {
    edit.edit((b) => {
      const x = b.blocks.find((y) => y.id === id);
      const p = x && paramsWith(x.params, f, v);
      return p ? set(b, id, p) : b;
    });
  }

  // The block changes or the tab closes during typing: it is saved, not lost.
  $effect(() => () => untrack(() => [...timers.keys()].forEach(validate)));

  const fieldText = (f: FormField) => inputs[f.name] ?? textOf(f, block.params[f.name]);
</script>

<div class="form">
  <label class="field">
    <span class="label">Nom</span>
    <input
      data-testid="block-name-field"
      value={inputs[NAME] ?? block.name ?? ""}
      placeholder={id}
      maxlength="60"
      onfocus={(e) => enter(NAME, e.currentTarget.value)}
      oninput={(e) => typeText(NAME, e.currentTarget.value)}
      onblur={() => quit(NAME)}
    />
  </label>
  <div class="field">
    <span class="label">Identifiant</span>
    <code data-testid="block-id">{id}</code>
  </div>

  {#each fieldList as f (f.name)}
    {#if f.kind === "checkbox"}
      <label class="field case">
        <input
          type="checkbox"
          data-testid="field-{f.name}"
          checked={entryOf(f, block.params) === true}
          onchange={(e) => choose(f, e.currentTarget.checked)}
        />
        <span class="label">{f.label}</span>
      </label>
    {:else if f.kind === "choice"}
      {@const v = block.params[f.name]}
      <label class="field">
        <span class="label">{f.label}{f.required ? " *" : ""}</span>
        <select data-testid="field-{f.name}" value={typeof v === "string" ? v : ""} onchange={(e) => choose(f, e.currentTarget.value)}>
          {#if f.required && typeof v !== "string"}<option value="" disabled>— choisir —</option>{/if}
          {#if !f.required}<option value="">Par défaut{f.default === undefined ? "" : ` (${textOf(f, f.default)})`}</option>{/if}
          {#each f.choices ?? [] as c (c)}<option value={c}>{c}</option>{/each}
          {#if typeof v === "string" && v !== "" && !(f.choices ?? []).includes(v)}<option value={v}>{v}</option>{/if}
        </select>
      </label>
    {:else}
      <label class="field">
        <span class="label">
          {f.label}{f.required ? " *" : ""}
          {#if f.kind === "template"}<span class="mark" title="Les {'{chemins}'} sont remplacés par les valeurs reçues">gabarit</span>{/if}
        </span>
        {#if f.kind === "number"}
          <input
            type="number"
            data-testid="field-{f.name}"
            min={f.min}
            max={f.max}
            step={f.integer ? 1 : "any"}
            value={fieldText(f)}
            placeholder={textOf(f, f.default)}
            onfocus={(e) => enter(f.name, e.currentTarget.value)}
            oninput={(e) => {
              // An unreadable input (« - ») reads as empty: the key must not go out for that.
              if (!e.currentTarget.validity.badInput) note(f.name, e.currentTarget.value);
            }}
            onkeydown={(e) => e.key === "Enter" && validate(f.name)}
            onblur={(e) => {
              quit(f.name);
              // Still unreadable: the field shows the block's value again.
              if (e.currentTarget.validity.badInput) e.currentTarget.value = textOf(f, block.params[f.name]);
            }}
          />
        {:else if f.kind === "text"}
          <input
            data-testid="field-{f.name}"
            value={fieldText(f)}
            placeholder={textOf(f, f.default)}
            spellcheck="false"
            onfocus={(e) => enter(f.name, e.currentTarget.value)}
            oninput={(e) => typeText(f.name, e.currentTarget.value)}
            onblur={() => quit(f.name)}
          />
        {:else}
          <textarea
            data-testid="field-{f.name}"
            rows={f.kind === "texts" ? 3 : 2}
            value={fieldText(f)}
            placeholder={f.kind === "texts" ? "Une valeur par ligne" : textOf(f, f.default)}
            spellcheck="false"
            onfocus={(e) => enter(f.name, e.currentTarget.value)}
            oninput={(e) => typeText(f.name, e.currentTarget.value)}
            onblur={() => quit(f.name)}
          ></textarea>
        {/if}
      </label>
      {#if f.kind === "template" && available && available.length > 0}
        <p class="help" data-testid="available-{f.name}">Champs disponibles : {available.map((c) => `{${c}}`).join(" ")}</p>
      {/if}
    {/if}
    {#if f.help}<p class="help">{f.help}</p>{/if}
  {/each}
</div>

<style>
  .form { display: flex; flex-direction: column; gap: 4px; }
  .field { display: flex; flex-direction: column; gap: 3px; margin-top: 6px; font-size: 12px; }
  .field.case { flex-direction: row; align-items: center; gap: 6px; }
  .label { color: var(--text-muted); display: flex; align-items: center; gap: 6px; }
  .mark { font-size: 10px; padding: 0 6px; border-radius: 6px; background: var(--glass-hi); color: var(--text); }
  input:not([type="checkbox"]), select, textarea {
    box-sizing: border-box; width: 100%; padding: 6px 8px; border-radius: 10px; border: 1px solid var(--border);
    background: var(--glass-hi); color: var(--text); font: inherit; font-size: 12px;
  }
  :is(input, select, textarea):focus { border-color: var(--accent); outline: none; }
  input[type="checkbox"] { accent-color: var(--accent); }
  textarea { resize: vertical; font-family: var(--font-mono); }
  code { font-size: 12px; color: var(--text); word-break: break-all; }
  .help { margin: 0; font-size: 11px; color: var(--text-muted); word-break: break-word; }
</style>
