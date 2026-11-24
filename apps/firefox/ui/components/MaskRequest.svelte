<script lang="ts">
  import { fade } from "svelte/transition";
  import { UNLOCK_REASON_LENGTH } from "../../shared/extensions-messages";
  import { siteOf, type Decision, type PendingRequest } from "../../shared/model";
  import { api } from "../state.svelte";
  import { t } from "../i18n.svelte";
  import MaskReveal from "./MaskReveal.svelte";
  import { dangerLines } from "./danger-lines";
  import { showSection } from "./settings-section.svelte";

  /**
   * The masking cards (spec § 8): reveal, fill, label alert, dev tools unlock. They name the value (« votre code »),
   * never carry it; « Voir » fetches it on click. Enter refuses on each: a keystroke meant elsewhere never lets a value out.
   */
  let { request }: { request: PendingRequest } = $props();

  const mask = $derived<NonNullable<PendingRequest["mask"]>>(request.mask ?? {});
  const kind = $derived(request.permissions[0]);
  /** Kernel texts and names: data, shown as text and bounded. */
  const bound = (s: string | undefined) => (s ?? "").slice(0, UNLOCK_REASON_LENGTH);
  const lines = $derived(dangerLines(request.danger));
  const labels = $derived((mask.labels ?? []).slice(0, 10));
  const count = $derived(Math.min(Math.max(0, Math.floor(mask.loginCount ?? 0)), 20));
  /** Passport fill rows (chrome's lines, entries by reference): bounded like the kernel's (11 `also` rows and the field). */
  const rows = $derived((mask.rows ?? []).slice(0, 12).map((r) => ({ line: bound(r.line), missing: r.missing && bound(r.missing), choices: (r.choices ?? []).slice(0, 50) })));
  /** A kind the passport has none of: the card only refuses (the agent gets the refusal text either way). */
  const missing = $derived(rows.some((r) => r.missing));
  let seeing = $state(false);
  let login = $state(0);
  /** The entry picked per row, by request and row. Only a lone entry is picked for the user (design § 8.3): masked, two look alike. */
  let chosen = $state<Record<string, string>>({});
  const pickOf = (i: number) => chosen[`${request.id}:${i}`] ?? (rows[i]?.choices.length === 1 ? rows[i]!.choices[0]!.ref : null);
  /** « Remplir » waits for a pick on every row that offers entries. */
  const unpicked = $derived(rows.some((r, i) => r.choices.length > 0 && pickOf(i) === null));
  /** « Retenir ce site » (task 13b): a kind row's box belongs to one choice, shown while it is the pick; each choice's box starts unticked. */
  let ticked = $state<Record<string, boolean>>({});
  const boxes = $derived((mask.remember ?? []).slice(0, 12).filter((b) => b.choice === undefined || pickOf(b.row) === b.choice).map((b) => ({ row: b.row, text: bound(b.text), key: `${request.id}:${b.row}:${b.choice ?? ""}` })));
  const remembering = $derived(boxes.some((b) => ticked[b.key]));
  /** The saved logins' usernames, fetched from the host on « Voir » (this window's card only), dropped when hidden. */
  let names = $state<string[] | null>(null);
  let fetches = 0;
  $effect(() => {
    const n = ++fetches;
    const ref = mask.loginsRef;
    if (!seeing || !ref) return void (names = null);
    void api.agent.revealLogins(ref).then((v) => void (n === fetches && seeing && (names = v)));
  });
  /** The passport values on offer, fetched from the host on « Voir » (this window's card only), dropped when hidden. */
  let values = $state<Record<string, string> | null>(null);
  let valueFetches = 0;
  $effect(() => {
    const n = ++valueFetches;
    const refs = rows.flatMap((r) => r.choices.map((c) => c.ref));
    if (!seeing || !refs.length) return void (values = null);
    void Promise.all(refs.map((r) => api.agent.revealPassport(r))).then((v) => {
      if (n === valueFetches && seeing) values = Object.fromEntries(refs.flatMap((r, i) => (v[i] === null ? [] : [[r, v[i]!]])));
    });
  });
  const choiceText = (c: { ref: string; shown: string }) => bound((seeing && values?.[c.ref]) || c.shown);
  const nameOf = (i: number) => (seeing && names?.[i]) || t("home-request-mask-login", { n: i + 1 });
  const answer = (d: Decision) => {
    // The values leave the card with the answer, whatever its fade does.
    seeing = false;
    names = null;
    values = null;
    const picks = rows.length ? { picks: rows.map((_, i) => pickOf(i)) } : {};
    const remember = boxes.filter((b) => ticked[b.key]).map((b) => b.row);
    api.permissions.answer(request.id, d, undefined, kind === "mask-fill" && (count || rows.length || remember.length) ? { ...(count ? { login } : {}), ...picks, ...(remember.length ? { remember } : {}) } : undefined);
  };
  /** Refused, then Réglages › Passeport on the card's profile (else the active space's): add the value, then ask the agent again. */
  const openPassport = () => {
    // Read before the answer: it takes the request out of the store, and `request` with it.
    const profile = mask.profile;
    answer("deny");
    showSection("passport", profile ? { profile } : {});
    api.dispatch({ type: "openSettings", windowId: api.windowId });
  };
  const ALLOW: Record<string, string> = {
    "mask-reveal": "home-request-mask-reveal-allow",
    "mask-fill": "home-request-mask-fill-allow",
    "mask-label-alert": "home-request-mask-alert-allow",
    "mask-devtools": "home-request-mask-devtools-allow",
  };
</script>

<div class="reading" data-testid="mask-request" data-kind={kind}>
  {#if kind === "mask-fill" && mask.text}
    <p>{bound(mask.text)}</p>
  {:else if kind === "mask-fill"}
    <p>{t("home-request-mask-fill", { name: bound(mask.name), field: bound(mask.field), where: bound(mask.where) })}</p>
  {:else if kind === "mask-devtools"}
    <p>{t("home-request-mask-devtools", { site: siteOf(request.origin), tab: bound(request.title ?? request.origin) })}</p>
    <p class="reason">{bound(mask.text)}</p>
  {:else}
    <p>{bound(mask.text)}</p>
  {/if}
  {#if kind === "mask-fill" && mask.domain}<p class="domain" data-testid="mask-request-domain">{t("home-request-mask-domain", { domain: mask.domain.slice(0, 253) })}</p>{/if}
  {#if mask.note}<p class="reason" data-testid="mask-request-profile">{bound(mask.note)}</p>{/if}
  {#each rows as row, i (i)}
    <div class="row" data-testid="mask-request-row">
      <p class="reason">{row.line}</p>
      {#if row.missing}
        <p class="reason" data-testid="mask-request-missing">{row.missing}</p>
      {:else if row.choices.length > 1}
        <div class="logins" role="radiogroup" aria-label={row.line}>
          {#each row.choices as c (c.ref)}
            <label><input type="radio" name="pick-{request.id}-{i}" checked={pickOf(i) === c.ref} onchange={() => (chosen[`${request.id}:${i}`] = c.ref)} /> <span class="choice">{choiceText(c)}</span></label>
          {/each}
        </div>
      {:else if row.choices.length === 1}
        <p class="reason choice" data-testid="mask-request-choice">{choiceText(row.choices[0]!)}</p>
      {/if}
    </div>
  {/each}
  {#each boxes as b (b.key)}
    <label class="remember" data-testid="mask-request-remember"><input type="checkbox" checked={!!ticked[b.key]} onchange={(e) => (ticked[b.key] = e.currentTarget.checked)} /> {b.text}</label>
  {/each}
  {#if remembering}
    <p class="reason hint" data-testid="mask-request-remember-hint" out:fade={{ duration: 150 }}>{t("home-request-mask-fill-remember-hint")}</p>
  {/if}
  {#if request.reason}<p class="reason">{t("home-request-address-reason", { reason: bound(request.reason) })}</p>{/if}
  {#each lines as line, i (i)}<p class="reason danger" role="alert" data-testid="mask-request-danger">{t("home-request-address-danger", { danger: line })}</p>{/each}
  {#if count > 1}
    <div class="logins" role="radiogroup" aria-label={t("home-request-mask-logins")}>
      {#each { length: count } as _, i (i)}
        <label><input type="radio" name="login-{request.id}" checked={login === i} onchange={() => (login = i)} /> {nameOf(i)}</label>
      {/each}
    </div>
  {:else if count === 1 && seeing && names?.[0]}
    <p class="reason login">{names[0]}</p>
  {/if}
  {#if labels.length || count || rows.some((r) => r.choices.length)}
    <MaskReveal text={labels.join("\n")} {labels} bind:seeing />
  {/if}
  <div class="actions">
    {#if missing && mask.profile}<button data-testid="mask-request-open-passport" onclick={openPassport}>{t("agent-mask-passport-open")}</button>{/if}
    <button data-main onclick={() => answer("deny")}>{t("home-deny")}</button>
    {#if !missing}<button class="allow" disabled={unpicked} onclick={() => answer("allow")}>{t(ALLOW[kind ?? ""] ?? "home-allow")}</button>{/if}
  </div>
</div>

<style>
  .reading p { margin: 0 0 12px; font-size: 14px; overflow-wrap: anywhere; }
  .reading p.reason { font-size: 13px; color: var(--text-muted, inherit); }
  .reading p.domain { font-family: var(--font-mono); font-size: 13px; font-weight: 600; }
  .reading p.reason.danger { color: var(--in-error); font-weight: 500; }
  .reading p.login { font-family: var(--font-mono); font-size: 12px; animation: ressac-rise var(--spring-d) var(--spring) backwards; }
  .row { animation: ressac-rise var(--spring-d) var(--spring) backwards; }
  .row p.reason { margin-bottom: 6px; }
  .choice { font-family: var(--font-mono); font-size: 12px; }
  .remember { display: flex; gap: 6px; align-items: baseline; margin: 0 0 8px; font-size: 13px; animation: ressac-rise var(--spring-d) var(--spring) backwards; }
  .reading p.hint { animation: ressac-rise var(--spring-d) var(--spring) backwards; }
  .logins { display: flex; flex-direction: column; gap: 4px; margin: 0 0 12px; font-size: 13px; }
  .actions { display: flex; justify-content: flex-end; gap: 8px; }
  button { padding: 7px 14px; border-radius: 10px; border: 1px solid var(--border); background: var(--glass-hi); color: var(--text); font: 600 12.5px var(--font-ui); cursor: pointer; transition: transform var(--tap), background var(--tap); }
  button:hover:not(:disabled) { background: var(--bg-active); }
  button:active:not(:disabled) { transform: scale(0.97); }
  button:disabled { opacity: 0.5; cursor: default; }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .allow { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
</style>
