<script lang="ts" module>
  /** A relock that discarded an open editor as the section was left: said when the section shows again. */
  let discardedOnLeave = false;
</script>

<script lang="ts">
  import { onDestroy, untrack } from "svelte";
  import { flip } from "svelte/animate";
  import { cubicOut } from "svelte/easing";
  import { fade } from "svelte/transition";
  import type { PassportProfile } from "../../shared/api";
  import { FIELD_GROUP, FIELD_LABEL, PASSPORT_FIELDS, PASSPORT_LIMITS, cleanOrigin, dayFirst, maskedDisplay, validateEntry, type PassportEntry, type PassportField, type Problem } from "../../chrome/shims/kernel";
  import { api, appState, currentWindow } from "../state.svelte";
  import { t } from "../i18n.svelte";
  import Icon from "./Icon.svelte";
  import PassportImport from "./PassportImport.svelte";
  import { onLeavingPassport, requestedPassport, takeRequestedPassport } from "./settings-section.svelte";

  // Styles of groups, rows, pills and buttons come from Settings.svelte. Design § 9.2-9.3, mock-up screen 1.
  const p = api.settings.passport!;
  const GROUPS = ["identite", "contact", "banque", "documents", "autre"] as const;
  const NAMED = new Set<PassportField>(["nom", "proche"]);
  const WITH_VARIANTS = new Set<PassportField>(["nom", "proche", "adresse", "libre"]);
  /** As-you-type formatting (mock-up `FMT`). The plate keeps the old « 1234 AB 56 » format as typed. */
  const FMT: Partial<Record<PassportField, (v: string) => string>> = {
    iban: (v) => v.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 34).replace(/(.{4})(?=.)/g, "$1 "),
    tel: (v) => (v.trim().startsWith("+") ? v.replace(/[^\d+ ]/g, "") : v.replace(/\D/g, "").slice(0, 10).replace(/(\d{2})(?=\d)/g, "$1 ")),
    secu: (v) => {
      const d = v.toUpperCase().replace(/[^\dAB]/g, "").slice(0, 15);
      const out: string[] = [];
      let i = 0;
      for (const n of [1, 2, 2, 2, 3, 3, 2]) if (i < d.length) out.push(d.slice(i, (i += n)));
      return out.join(" ");
    },
    plaque: (v) => {
      if (!/^[A-Za-z]/.test(v)) return v.toUpperCase();
      const d = v.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 7);
      return [d.slice(0, 2), d.slice(2, 5), d.slice(5)].filter(Boolean).join("-");
    },
    piece: (v) => v.toUpperCase().replace(/\s/g, ""),
  };
  const MONO = new Set<PassportField>(["iban", "tel", "secu", "plaque", "piece"]);

  type Open = { token: string; until: number; showMs: number; entries: PassportEntry[]; revision: string; dropped: number };
  type Draft = { id: string | null; field: PassportField; given: string; family: string; text: string; variants: string[]; origins: string[]; deleting: boolean; error: string | null };
  type ChipKind = "variants" | "origins";

  let profiles = $state<PassportProfile[] | null>(null);
  let current = $state<string | null>(null);
  let open = $state<Open | null>(null);
  let now = $state(Date.now());
  let shown = $state<Record<string, boolean>>({});
  let editor = $state<Draft | null>(null);
  let chipIn = $state<Record<ChipKind, string>>({ variants: "", origins: "" });
  let chipHint = $state<Record<ChipKind, string | null>>({ variants: null, origins: null });
  /** A page notice: the relock that discarded an editor. */
  let notice = $state<string | null>(discardedOnLeave ? "settings-passport-discarded" : null);
  discardedOnLeave = false;
  /** After a good save: the conversations marked « non couverte » (0: none). */
  let saved = $state<number | null>(null);
  /** The row just saved, lit briefly. */
  let fresh = $state<string | null>(null);
  let busy = false;
  /** « Importer depuis… »: the sources offered (null: closed), then the one picked. */
  let importFrom = $state<{ id: string; name: string; count: number }[] | null>(null);
  let importing = $state<string | null>(null);
  const openImport = () => void api.passportImport.sources().then((l) => (importFrom = l));
  const closeImport = () => ([importFrom, importing] = [null, null]);
  /** Touch ID is asked: the button waits for its answer (no second prompt). */
  let unlocking = $state(false);
  /** « Supprimer ce passeport » or « Recommencer un passeport vide » after its Touch ID: the confirmation, holding that token. */
  let confirming = $state<{ token: string; until: number; purpose: "delete" | "restart" } | null>(null);
  /** « Déplacer vers… » open: the target profiles listed. */
  let picking = $state(false);
  /** A delete or move under way (Touch ID or the chrome's answer): its buttons wait. */
  let acting = $state(false);
  let actionError = $state<string | null>(null);
  const timers = new Set<ReturnType<typeof setTimeout>>();

  const profile = $derived(profiles?.find((x) => x.id === current) ?? null);
  const readOnly = $derived(profile?.state === "newer");
  /** A passport on disk: deletable, whatever its state (design § 4.4). */
  const onDisk = $derived(!!profile && (profile.kept || profile.count > 0 || profile.state !== "ok"));
  const targets = $derived(profiles?.filter((x) => x.id !== current && !x.kept && x.state === "ok") ?? []);
  const fieldName = (f: PassportField) => t(`settings-passport-field-${f}`);
  const labelOf = (f: PassportField) => `⟨${FIELD_LABEL[f]}-…⟩`;
  /** A text with one label inside, split around it so the label is drawn as a chip. */
  const around = (id: string, args: Record<string, string>, label: string) => t(id, { ...args, label: "\u0001" }).split("\u0001").concat(label);

  const loadProfiles = () =>
    p.profiles().then((l) => {
      profiles = l;
      if (current && l.some((x) => x.id === current)) return;
      const active = appState.value?.spaces.find((s) => s.id === currentWindow()?.activeSpace)?.profile;
      current = l.find((x) => x.id === active)?.id ?? l[0]?.id ?? null;
    });
  $effect(() => void loadProfiles());
  // « Ouvrir le passeport » (agent panel) or showSection("passport", { profile }): that profile.
  $effect(() => {
    const asked = requestedPassport();
    if (!asked) return;
    untrack(() => {
      takeRequestedPassport();
      choose(asked);
    });
  });

  function relock() {
    if (current && (open || confirming)) p.lock(current);
    confirming = null;
    picking = false;
    actionError = null;
    if (editor) notice = "settings-passport-discarded";
    for (const x of timers) clearTimeout(x);
    timers.clear();
    open = null;
    editor = null;
    shown = {};
    saved = null;
    fresh = null;
  }
  function choose(id: string) {
    if (id === current) return;
    relock();
    current = id;
  }

  // The countdown, and the relock 5 minutes after unlocking (the mock-up: not an idle delay).
  $effect(() => {
    if (!open) return;
    const tick = setInterval(() => {
      now = Date.now();
      if (open && now >= open.until) relock();
    }, 1000);
    return () => clearInterval(tick);
  });
  // Relock when the Mac sleeps or its screen locks (chrome), when the page is hidden or closed. Not on a focus loss.
  $effect(() => p.onLocked(relock));
  $effect(() => {
    const hidden = () => document.visibilityState === "hidden" && relock();
    const gone = () => relock();
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("pagehide", gone);
    return () => {
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("pagehide", gone);
    };
  });
  // Leaving the section relocks; a discarded editor is said when the section shows again. The section switch calls it
  // before any teardown; leaving the tab relocks at the destroy, which no outro delays (this page has no global one).
  const leave = () => {
    if (editor) discardedOnLeave = true;
    relock();
  };
  $effect(() => onLeavingPassport(leave));
  onDestroy(leave);

  async function unlock() {
    const id = current;
    if (!id) return;
    notice = null;
    unlocking = true;
    try {
      const u = await p.unlock(id);
      if (!u) return;
      // The profile changed during Touch ID: its token is revoked at once (no live token, no screen poll left behind).
      if (id !== current) return void p.lock(id);
      const r = await p.read(id, u.token);
      if (!r || id !== current) return void p.lock(id);
      now = Date.now();
      open = { ...u, ...r };
    } finally {
      unlocking = false;
    }
  }

  /** A fresh Touch ID for a delete, a move or a restart: a token for that alone (single use, it never reads). */
  async function askAgain(id: string, purpose: "delete" | "move" | "restart"): Promise<{ token: string; until: number } | null> {
    const u = await p.unlock(id, purpose);
    if (!u) return null;
    if (id !== current) {
      p.lock(id, purpose);
      return null;
    }
    return u;
  }
  async function askConfirm(purpose: "delete" | "restart") {
    const id = current;
    if (!id || acting) return;
    notice = actionError = null;
    picking = false;
    acting = true;
    const u = await askAgain(id, purpose).finally(() => (acting = false));
    if (u) confirming = { token: u.token, until: u.until, purpose };
  }
  function keepPassport() {
    if (current && confirming) p.lock(current, confirming.purpose);
    confirming = null;
  }
  // The confirmation goes with its token: past it, « Supprimer » could only fail.
  $effect(() => {
    if (!confirming) return;
    const x = setTimeout(keepPassport, Math.max(0, confirming.until - Date.now()));
    return () => clearTimeout(x);
  });
  async function confirmAction() {
    const id = current;
    if (!id || !confirming || acting) return;
    const { token, purpose } = confirming;
    acting = true;
    const ok = await (purpose === "restart" ? p.restart(id, token) : p.removePassport(id, token)).finally(() => (acting = false));
    if (id !== current) return;
    // A refused delete leaves the page as a relock does: tokens revoked (a failed removal revokes them all).
    relock();
    if (purpose === "restart") actionError = ok ? null : "settings-passport-restart-failed";
    else if (ok) notice = "settings-passport-removed";
    else actionError = "settings-passport-remove-failed";
    void loadProfiles();
  }
  async function move(to: string) {
    const id = current;
    if (!id || acting) return;
    notice = actionError = null;
    acting = true;
    try {
      const u = await askAgain(id, "move");
      if (!u) return;
      const r = await p.moveTo(id, to, u.token);
      if (id !== current) return;
      relock();
      if (r.ok) {
        notice = "settings-passport-moved";
        current = to;
      } else actionError = { locked: "settings-passport-move-failed", write: "settings-passport-move-failed", full: "settings-passport-move-full", copied: "settings-passport-move-copied", unread: "settings-passport-move-unread" }[r.error];
      void loadProfiles();
    } finally {
      acting = false;
    }
  }

  const countdown = $derived.by(() => {
    const s = open ? Math.max(0, Math.ceil((open.until - now) / 1000)) : 0;
    return { minutes: String(Math.floor(s / 60)), seconds: String(s % 60).padStart(2, "0") };
  });

  function show(id: string) {
    if (shown[id]) return void delete shown[id];
    shown[id] = true;
    const x = setTimeout(() => {
      timers.delete(x);
      delete shown[id];
    }, open?.showMs ?? 20_000);
    timers.add(x);
  }
  const clear = (e: PassportEntry) => ("given" in e.value ? `${e.value.given} ${e.value.family}` : e.field === "naissance" ? dayFirst(e.value.text) : e.value.text);

  // The editor.
  const draftOf = (e: PassportEntry): Draft => ({
    id: e.id,
    field: e.field,
    given: "given" in e.value ? e.value.given : "",
    family: "given" in e.value ? e.value.family : "",
    text: "text" in e.value ? e.value.text : "",
    variants: [...e.variants],
    origins: [...e.origins],
    deleting: false,
    error: null,
  });
  function edit(d: Draft) {
    editor = d;
    chipIn = { variants: "", origins: "" };
    chipHint = { variants: null, origins: null };
    saved = null;
  }
  const add = (field: PassportField) => edit({ id: null, field, given: "", family: "", text: "", variants: [], origins: [], deleting: false, error: null });
  function entryOf(d: Draft, at = new Date().toISOString()): PassportEntry {
    const before = open?.entries.find((e) => e.id === d.id);
    return {
      id: d.id ?? crypto.randomUUID(),
      field: d.field,
      value: NAMED.has(d.field) ? { given: d.given.trim(), family: d.family.trim() } : { text: d.text.trim() },
      variants: WITH_VARIANTS.has(d.field) ? d.variants : [],
      origins: d.origins,
      how: before?.how ?? "typed",
      ...(before?.from ? { from: before.from } : {}),
      created: before?.created ?? at,
      updated: at,
    };
  }
  const empty = $derived(!editor || (NAMED.has(editor.field) ? !editor.given.trim() && !editor.family.trim() : !editor.text.trim()));
  const check = $derived(editor && open ? validateEntry(entryOf(editor, ""), open.entries) : null);
  const canSave = $derived(!!check && !empty && !check.problems.length);
  const problemText = (x: Problem) => t(`settings-passport-problem-${x.code}`, x.code === "long" ? { max: String(x.at === "variant" ? PASSPORT_LIMITS.variant : PASSPORT_LIMITS.value) } : {});
  /** The value's hint: its problem, else the IBAN's or the number's key confirmed, else a warning. */
  const hint = $derived.by((): { text: string; tone: "ok" | "bad" | "" } | null => {
    if (!editor || !check || empty) return null;
    const bad = check.problems.find((x) => x.at === "value");
    if (bad) return { text: problemText(bad), tone: "bad" };
    if (editor.field === "iban" || editor.field === "secu") return { text: t(`settings-passport-ok-${editor.field}`), tone: "ok" };
    const warn = check.warnings.find((w) => w.index === undefined);
    return warn ? { text: t(`settings-passport-warning-${warn.code}`), tone: "" } : null;
  });

  function typed(e: Event & { currentTarget: HTMLInputElement | HTMLTextAreaElement }) {
    if (!editor) return;
    const f = FMT[editor.field];
    const v = f ? f(e.currentTarget.value) : e.currentTarget.value;
    if (v !== e.currentTarget.value) e.currentTarget.value = v;
    editor.text = v;
  }
  function changeType(field: PassportField) {
    if (!editor) return;
    // Changing the type empties the value (design § 9.2).
    Object.assign(editor, { field, given: "", family: "", text: "", variants: WITH_VARIANTS.has(field) ? editor.variants : [] });
  }

  function shake(el: HTMLElement | null | undefined) {
    if (!el || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    el.classList.remove("shake");
    void el.offsetWidth;
    el.classList.add("shake");
  }
  /** Adds the typed chip; false (and a shake) when refused, with the reason under the chips. */
  function addChip(kind: ChipKind, input?: HTMLInputElement | null): boolean {
    if (!editor || !open) return false;
    const raw = chipIn[kind];
    if (!raw.trim()) return true;
    const v = kind === "origins" ? (cleanOrigin(raw) ?? raw.trim()) : raw.trim();
    const next = [...editor[kind], v];
    const r = validateEntry(entryOf({ ...editor, [kind]: next }, ""), open.entries);
    const at = kind === "origins" ? "origin" : "variant";
    const bad = editor[kind].includes(v) ? null : r.problems.find((x) => x.at === at && (x.index === undefined || x.index === next.length - 1));
    if (editor[kind].includes(v) || bad) {
      chipHint[kind] = bad ? problemText(bad) : null;
      shake(input);
      return false;
    }
    editor[kind] = next;
    chipIn[kind] = "";
    const warn = kind === "variants" && r.warnings.find((w) => w.index === next.length - 1);
    chipHint[kind] = warn ? t(`settings-passport-warning-${warn.code}`) : null;
    return true;
  }
  function chipKey(kind: ChipKind, e: KeyboardEvent & { currentTarget: HTMLInputElement }) {
    if (!editor) return;
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      e.stopPropagation();
      addChip(kind, e.currentTarget);
    } else if (e.key === "Backspace" && !chipIn[kind] && editor[kind].length) editor[kind] = editor[kind].slice(0, -1);
  }
  function editorKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      editor = null;
    } else if (e.key === "Enter" && !(e.target instanceof HTMLTextAreaElement) && !(e.target instanceof HTMLButtonElement) && canSave) {
      e.preventDefault();
      void commit();
    }
  }
  const focusFirst = (node: HTMLElement) => void (node.querySelector("input, textarea, select") as HTMLElement | null)?.focus();

  /** Saves the passport with the editor's entry (or without it, `remove`). The draft stays on a failure. */
  async function commit(remove = false) {
    if (!editor || !open || busy || !current) return;
    // A host typed but not added yet goes with the save, as in the mock-up.
    for (const kind of ["variants", "origins"] as const) if (chipIn[kind].trim() && !addChip(kind)) return;
    const d = editor;
    const entry = entryOf(d);
    const next = remove ? open.entries.filter((e) => e.id !== d.id) : d.id ? open.entries.map((e) => (e.id === d.id ? entry : e)) : [...open.entries, entry];
    const id = current;
    busy = true;
    const r = await p.save(id, open.token, $state.snapshot(next), open.revision).finally(() => (busy = false));
    if (!open || id !== current) return;
    if (r.ok) {
      open.entries = next;
      open.revision = r.revision;
      if (editor === d) editor = null;
      fresh = remove ? null : entry.id;
      saved = r.uncovered;
      void loadProfiles();
    } else if (r.error === "locked") relock();
    else d.error = { stale: "settings-passport-stale", write: "settings-passport-save-failed", newer: "settings-passport-newer", full: "settings-passport-problem-full", invalid: "settings-passport-save-invalid" }[r.error];
  }

  const groups = $derived(open ? GROUPS.map((g) => ({ g, entries: open!.entries.filter((e) => FIELD_GROUP[e.field] === g) })).filter((x) => x.entries.length) : []);
</script>

{#snippet withLabel(parts: string[])}{parts[0]}<span class="lbl">{parts[2]}</span>{parts[1]}{/snippet}

{#snippet chips(kind: ChipKind)}
  {@const isOrigins = kind === "origins"}
  <div class="field">
    <span id="pp-{kind}">{t(isOrigins ? "settings-passport-origins-label" : "settings-passport-variants")}</span>
    <div class="chips" data-testid="passport-{kind}">
      {#each editor?.[kind] ?? [] as v, i (v)}
        <span class="chip" out:fade={{ duration: 150 }}>{v}<button type="button" aria-label={t("settings-passport-chip-remove", { value: v })} onclick={() => editor && (editor[kind] = editor[kind].filter((_, k) => k !== i))}>×</button></span>
      {/each}
      <input aria-labelledby="pp-{kind}" data-testid="passport-{kind}-input" bind:value={chipIn[kind]} placeholder={t(isOrigins ? "settings-passport-origins-example" : "settings-passport-variants-example")} onkeydown={(e) => chipKey(kind, e)} />
    </div>
    {#if chipHint[kind]}<span class="hint bad" data-testid="passport-{kind}-hint">{chipHint[kind]}</span>{/if}
    <span class="help">{t(isOrigins ? "settings-passport-origins-help" : "settings-passport-variants-help")}</span>
  </div>
{/snippet}

{#snippet editorView(d: Draft)}
  <!-- svelte-ignore a11y_no_static_element_interactions: Enter saves and Escape cancels from any of its fields -->
  <div class="editor" data-testid="passport-editor" onkeydown={editorKey} use:focusFirst>
    <h4>{d.id ? t("settings-passport-editor-edit", { field: fieldName(d.field) }) : t("settings-passport-editor-add")}</h4>
    {#if !d.id}
      <label class="field"><span>{t("settings-passport-type")}</span>
        <select data-testid="passport-type" value={d.field} onchange={(e) => changeType(e.currentTarget.value as PassportField)}>
          {#each GROUPS as g (g)}
            <optgroup label={t(`settings-passport-group-${g}`)}>
              {#each PASSPORT_FIELDS.filter((f) => FIELD_GROUP[f] === g) as f (f)}<option value={f}>{fieldName(f)}</option>{/each}
            </optgroup>
          {/each}
        </select>
      </label>
    {/if}
    {#if NAMED.has(d.field)}
      <div class="pair">
        <label class="field"><span>{t("settings-passport-given")}</span><input data-testid="passport-given" bind:value={d.given} autocomplete="off" /></label>
        <label class="field"><span>{t("settings-passport-family")}</span><input data-testid="passport-family" bind:value={d.family} autocomplete="off" /></label>
      </div>
    {:else}
      <label class="field"><span>{t("settings-passport-value")}</span>
        {#if d.field === "adresse"}
          <textarea data-testid="passport-value" rows="2" value={d.text} oninput={typed}></textarea>
        {:else if d.field === "naissance"}
          <input data-testid="passport-value" type="date" max={new Date().toISOString().slice(0, 10)} min="1900-01-01" value={d.text} oninput={typed} />
        {:else}
          <input data-testid="passport-value" class:mono={MONO.has(d.field)} type={d.field === "email" ? "email" : d.field === "tel" ? "tel" : "text"} spellcheck="false" autocomplete="off" value={d.text} oninput={typed} />
        {/if}
      </label>
    {/if}
    <span class="hint {hint?.tone ?? ''}" data-testid="passport-hint" aria-live="polite">{hint?.text ?? ""}</span>
    {#if WITH_VARIANTS.has(d.field)}{@render chips("variants")}{/if}
    {@render chips("origins")}
    <p class="preview">{@render withLabel(around("settings-passport-preview", {}, labelOf(d.field)))}</p>
    {#if d.error}<p class="alert" role="alert" data-testid="passport-error">{t(d.error)}</p>{/if}
    {#if d.deleting}
      <div class="confirmation" role="alert" data-testid="passport-delete-confirm">
        <p>{t("settings-passport-delete-confirm", { field: fieldName(d.field) })}</p>
        <div class="buttons">
          <button data-testid="passport-keep" onclick={() => (d.deleting = false)}>{t("settings-passport-keep")}</button>
          <button class="danger" data-testid="passport-delete-yes" onclick={() => commit(true)}>{t("settings-passport-delete")}</button>
        </div>
      </div>
    {/if}
    <div class="buttons">
      {#if d.id && !d.deleting}<button class="danger" data-testid="passport-delete" onclick={() => (d.deleting = true)}>{t("settings-passport-delete")}</button><span class="spacer"></span>{/if}
      <button data-testid="passport-cancel" onclick={() => (editor = null)}>{t("settings-passport-cancel")}</button>
      <button class="primary" data-testid="passport-save" disabled={!canSave} onclick={() => commit()}>{t("settings-passport-save")}</button>
    </div>
  </div>
{/snippet}

<section data-testid="settings-passport" aria-label={t("settings-section-passport")}>
  <div class="head">
    <h3>{t("settings-section-passport")}</h3>
    {#if profiles && profiles.length > 1}
      <select aria-label={t("settings-passport-profiles")} data-testid="passport-profiles" value={current} onchange={(e) => choose(e.currentTarget.value)}>
        {#each profiles as x (x.id)}
          <option value={x.id} data-testid="passport-profile-{x.id}">{x.name}</option>
        {/each}
      </select>
    {/if}
  </div>
  {#if profile?.state === "ok"}
    <div class="importer" data-testid="passport-importer">
      {#if !importFrom}
        <button class="link" data-testid="passport-import-open" onclick={openImport}>{t("settings-passport-import-open")}</button>
      {:else if !importing}
        <span class="muted" out:fade={{ duration: 150 }}>{t("settings-passport-import-pick")}</span>
        {#each importFrom as s (s.id)}<button data-testid="passport-import-source-{s.id}" onclick={() => (importing = s.id)}>{s.name}</button>{/each}
        <button class="link" onclick={closeImport}>{t("settings-passport-import-later")}</button>
      {:else}
        <PassportImport source={importing} profile={current ?? undefined} onclose={closeImport} onadded={() => void loadProfiles()} />
      {/if}
    </div>
  {/if}
  <p class="intro">{@render withLabel(around("settings-passport-intro", {}, "⟨adresse-…⟩"))}</p>
  {#if notice}<p class="status alert appear" role="status" data-testid="passport-notice" out:fade={{ duration: 150 }}>{t(notice)}</p>{/if}

  <div class="stack">
    {#key current}
      <div class="body" in:fade={{ duration: 150 }} out:fade={{ duration: 150 }}>
        {#if profile?.kept}<p class="status" role="status" data-testid="passport-kept">{t("settings-passport-kept")}</p>{/if}
        {#if profile?.state === "newer"}<p class="status" role="status" data-testid="passport-newer">{t("settings-passport-newer")}</p>{/if}
        <!-- One grid cell: the locked box fades out over the opening passport instead of pushing it down first. -->
        <div class="swap">
        {#if profile?.state === "unreadable"}
          <div class="group lockbox" data-testid="passport-unreadable"><p>{t("settings-passport-unreadable")}</p></div>
        {:else if profile && !open}
          <div out:fade={{ duration: 150 }}>
          <div class="group lockbox" data-testid="passport-locked">
            <div class="ic"><Icon name="lock" size={24} /></div>
            <h4>{t(profile.count === 0 && profile.state === "ok" ? "settings-passport-empty-title" : "settings-passport-locked-title", { profile: profile.name })}</h4>
            <p>{t("settings-passport-locked-text")}</p>
            <button class="primary" data-testid="passport-unlock" disabled={unlocking} onclick={unlock}><Icon name="lock-open" size={15} />{t("settings-passport-unlock")}</button>
          </div>
          <p class="caption">{t("settings-passport-caption")}</p>
          </div>
        {:else if open}
          <div class="appear" data-testid="passport-open">
            <div class="unlockbar">
              <span class="pill" data-tone="ok" data-testid="passport-countdown">{t("settings-passport-unlocked", countdown)}</span>
              <span class="spacer"></span>
              <button data-testid="passport-lock" onclick={relock}><Icon name="lock" size={14} />{t("settings-passport-lock")}</button>
              {#if !readOnly}<button class="primary" data-testid="passport-add" onclick={() => add("libre")}><Icon name="plus" size={14} />{t("settings-passport-add")}</button>{/if}
            </div>
            {#if open.dropped}<p class="status alert" role="status" data-testid="passport-dropped">{t("settings-passport-dropped", { n: String(open.dropped) })}</p>{/if}
            {#if saved !== null}
              <div class="status appear" role="status" data-testid="passport-saved" out:fade={{ duration: 150 }}>
                <p>{t("settings-passport-saved")}</p>
                {#if saved > 0}<p data-testid="passport-uncovered">{t("settings-passport-uncovered", { n: String(saved) })}</p>{/if}
              </div>
            {/if}
            <!-- Local fades, on the element of the block that closes: a teardown of the page never waits for them. -->
            {#if editor && !editor.id}<div class="group" out:fade={{ duration: 150 }}>{@render editorView(editor)}</div>{/if}
            {#if !open.entries.length && !editor}
              <div class="group welcome" data-testid="passport-welcome">
                <p>{t("settings-passport-welcome")}</p>
                {#if !readOnly}
                  <div class="buttons">
                    <button data-testid="passport-add-name" onclick={() => add("nom")}>{t("settings-passport-add-name")}</button>
                    <button data-testid="passport-add-address" onclick={() => add("adresse")}>{t("settings-passport-add-address")}</button>
                    <button data-testid="passport-add-other" onclick={() => add("libre")}>{t("settings-passport-add-other")}</button>
                  </div>
                {/if}
              </div>
            {/if}
            {#each groups as { g, entries } (g)}
              <h4 class="group-title" out:fade={{ duration: 150 }}>{t(`settings-passport-group-${g}`)}</h4>
              <div class="group" out:fade={{ duration: 150 }}>
                {#each entries as e (e.id)}
                  <div animate:flip={{ duration: 120, easing: cubicOut }} out:fade={{ duration: 150 }}>
                    {#if editor?.id === e.id}
                      <div out:fade={{ duration: 150 }}>{@render editorView(editor!)}</div>
                    {:else}
                      <div class="row entry" class:fresh={fresh === e.id} data-testid="passport-row-{e.field}">
                        <div class="grow">
                          <b>{fieldName(e.field)}</b>
                          <span class="vals">{#key !!shown[e.id]}<span class="val" data-testid="passport-val" in:fade={{ duration: 150 }} out:fade={{ duration: 150 }}>{shown[e.id] ? clear(e) : maskedDisplay(e)}</span>{/key}</span>
                          <span class="muted">{e.origins.length ? t("settings-passport-origins", { sites: e.origins.join(", ") }) : t("settings-passport-no-origin")}</span>
                          <span class="muted">{@render withLabel(around("settings-passport-agent-sees", {}, labelOf(e.field)))}{e.variants.length ? " " + t("settings-passport-also", { variants: e.variants.join(" », « ") }) : ""}</span>
                        </div>
                        <button class="link" aria-pressed={!!shown[e.id]} data-testid="passport-see" onclick={() => show(e.id)}>{t(shown[e.id] ? "settings-passport-hide" : "settings-passport-show")}</button>
                        {#if !readOnly}<button class="icon" aria-label={t("settings-passport-edit", { field: fieldName(e.field) })} data-testid="passport-edit" onclick={() => edit(draftOf(e))}><Icon name="pencil" size={16} /></button>{/if}
                      </div>
                    {/if}
                  </div>
                {/each}
              </div>
            {/each}
            <p class="caption">{t("settings-passport-footer")}</p>
          </div>
        {/if}
        </div>
        {#if onDisk && profile}
          <div class="manage">
            {#if actionError}<p class="alert appear" role="alert" data-testid="passport-action-error" out:fade={{ duration: 150 }}>{t(actionError)}</p>{/if}
            {#if confirming?.purpose === "restart"}
              <div class="confirmation" role="alert" data-testid="passport-restart-confirm" out:fade={{ duration: 150 }}>
                <p>{t("settings-passport-restart-confirm")}</p>
                <div class="buttons">
                  <button data-testid="passport-restart-keep" disabled={acting} onclick={keepPassport}>{t("settings-passport-keep")}</button>
                  <button class="danger" data-testid="passport-restart-yes" disabled={acting} onclick={confirmAction}>{t("settings-passport-restart")}</button>
                </div>
              </div>
            {:else if confirming}
              <div class="confirmation" role="alert" data-testid="passport-remove-confirm" out:fade={{ duration: 150 }}>
                <p>{profile.state === "unreadable" ? t("settings-passport-remove-confirm-unread") : t("settings-passport-remove-confirm", { n: profile.count })}</p>
                <div class="buttons">
                  <button data-testid="passport-remove-keep" disabled={acting} onclick={keepPassport}>{t("settings-passport-keep")}</button>
                  <button class="danger" data-testid="passport-remove-yes" disabled={acting} onclick={confirmAction}>{t("settings-passport-delete")}</button>
                </div>
              </div>
            {:else}
              {#if picking}
                <div class="buttons targets appear" role="group" aria-label={t("settings-passport-move")} data-testid="passport-move-targets" out:fade={{ duration: 150 }}>
                  {#each targets as x (x.id)}<button data-testid="passport-move-to-{x.id}" disabled={acting} onclick={() => move(x.id)}>{x.name}</button>{/each}
                  <button disabled={acting} onclick={() => (picking = false)}>{t("settings-passport-cancel")}</button>
                </div>
              {/if}
              <div class="buttons" out:fade={{ duration: 150 }}>
                {#if profile.kept && profile.state === "ok" && targets.length && !picking}<button data-testid="passport-move" disabled={acting} out:fade={{ duration: 150 }} onclick={() => ((picking = true), (actionError = null))}>{t("settings-passport-move")}</button>{/if}
                <!-- Only a passport that cannot be decrypted is given up (a newer one is readable: never). -->
                {#if profile.state === "unreadable"}<button data-testid="passport-restart" disabled={acting} out:fade={{ duration: 150 }} onclick={() => askConfirm("restart")}>{t("settings-passport-restart")}</button>{/if}
                <button class="danger" data-testid="passport-remove" disabled={acting} onclick={() => askConfirm("delete")}>{t("settings-passport-remove")}</button>
              </div>
            {/if}
          </div>
        {/if}
      </div>
    {/key}
  </div>
</section>

<style>
  .importer { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 0 0 10px; }
  .importer > :global(.card) { flex: 1 1 100%; }
  .head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px; margin: 0 0 10px; }
  .head h3 { margin: 0; font: 600 20px/1.2 var(--font-display); letter-spacing: -0.015em; }
  /* Changing profile cross-fades the content: the old and the new body share one grid cell. */
  .stack { display: grid; }
  .stack > .body { grid-area: 1 / 1; min-width: 0; }
  .swap { display: grid; }
  .swap > * { grid-area: 1 / 1; min-width: 0; }
  .lbl { display: inline-flex; padding: 0 6px; border-radius: 7px; background: color-mix(in srgb, var(--accent) 14%, transparent); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 28%, transparent); color: var(--accent); font: 500 11.5px/1.6 var(--font-mono); white-space: nowrap; }
  .lockbox { display: flex; flex-direction: column; align-items: center; text-align: center; gap: 10px; padding: 34px 24px 28px; }
  .lockbox.group > * + * { border-top: 0; }
  .lockbox .ic { width: 46px; height: 46px; display: grid; place-items: center; border-radius: 14px; background: color-mix(in srgb, var(--accent) 14%, transparent); color: var(--accent); }
  .lockbox h4 { margin: 4px 0 0; font: 600 15px/1.3 var(--font-display); }
  .lockbox p { max-width: 440px; color: var(--text-muted); font-size: 12.5px; line-height: 1.5; }
  .lockbox button, .unlockbar button { display: inline-flex; align-items: center; gap: 6px; }
  .lockbox button { margin-top: 8px; }
  .unlockbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 0 0 18px; }
  .spacer { flex: 1; }
  .manage { display: grid; gap: 10px; margin: 18px 0 0; }
  .manage .buttons { justify-content: flex-start; }
  .welcome { display: flex; flex-direction: column; gap: 12px; padding: 18px 20px; }
  .welcome .buttons { justify-content: flex-start; }
  .entry { animation: ressac-rise var(--spring-d) var(--spring) backwards; }
  .entry.fresh { animation: ressac-rise var(--spring-d) var(--spring) backwards, passport-lit 1.2s ease-out; }
  @keyframes passport-lit { from { background: color-mix(in srgb, var(--accent) 12%, transparent); } }
  /* « Voir » / « Masquer » cross-fade: the old text and the new one share one grid cell. */
  .vals { display: grid; }
  .vals > .val { grid-area: 1 / 1; }
  .val { font: 500 12.5px/1.45 var(--font-mono); white-space: pre-line; overflow-wrap: anywhere; }
  .link { border: 0 !important; background: none !important; padding: 0 4px !important; color: var(--text-muted) !important; font-weight: 500 !important; text-decoration: underline; text-underline-offset: 2px; }
  .icon { display: grid; place-items: center; width: 28px; height: 28px; padding: 0 !important; border: 0 !important; border-radius: 8px; background: none !important; color: var(--text-muted) !important; }
  .icon:hover { background: var(--bg-hover) !important; color: var(--text) !important; }
  .editor { display: grid; gap: 12px; padding: 16px 20px 18px; background: color-mix(in srgb, var(--sheet) 70%, transparent); animation: ressac-drop var(--spring-d) var(--spring) backwards; }
  .editor h4 { margin: 0; font: 600 13.5px/1.3 var(--font-display); }
  .field { display: grid; gap: 5px; min-width: 0; }
  .field > span:first-child { font-size: 12px; font-weight: 500; color: var(--text-muted); }
  .field :is(input, select, textarea) { width: 100%; }
  .pair { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  @container (max-width: 520px) { .pair { grid-template-columns: 1fr; } }
  input.mono { font-family: var(--font-mono); letter-spacing: 0.02em; }
  .hint { min-height: 16px; font-size: 11.5px; color: var(--text-muted); }
  .hint.ok { color: var(--running); }
  .hint.bad { color: var(--in-error); }
  .chips { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; padding: 4px 6px; border-radius: 10px; border: 1px solid var(--border); background: var(--bg-hover); }
  .chips:focus-within { outline: 2px solid var(--accent); outline-offset: 1px; }
  .chips input { flex: 1; min-width: 120px; border: 0 !important; background: none !important; padding: 3px 4px !important; }
  .chips input:focus-visible { outline: none !important; }
  .chip { display: inline-flex; align-items: center; gap: 2px; padding: 2px 4px 2px 8px; border-radius: 8px; background: var(--bg-active); font-size: 12px; animation: ressac-rise var(--spring-d) var(--spring) backwards; }
  .chip button { border: 0 !important; background: none !important; padding: 0 4px !important; color: var(--text-muted) !important; font-size: 13px !important; line-height: 1; }
  .chips input:global(.shake) { animation: passport-shake 180ms; }
  @keyframes passport-shake { 33% { transform: translateX(-3px); } 66% { transform: translateX(3px); } }
  @media (prefers-reduced-motion: reduce) { .chips input:global(.shake) { animation: none; } }
  .preview { font-size: 12px; color: var(--text-muted); }
</style>
