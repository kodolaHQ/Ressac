<script lang="ts">
  import { fade } from "svelte/transition";
  import type { SettingsApi } from "../../shared/api";
  import { MACHINE_IDLE_MINUTES, type DockerStatus, type MachineIdleMinutes, type MachineShown, type MachineStatus, type WorkshopOperation } from "../../shared/settings";
  import { aiOn, api, appState } from "../state.svelte";
  import { t } from "../i18n.svelte";
  import AiAsleep from "./AiAsleep.svelte";
  import SettingsRow from "./SettingsRow.svelte";

  // Styles come from Settings.svelte.
  const s = api.settings;
  type WorkshopState = NonNullable<Awaited<ReturnType<SettingsApi["workshop"]>>>;
  /** undefined: loading; null: the host does not answer. */
  let workshop = $state<WorkshopState | null | undefined>(undefined);
  let operation = $state<WorkshopOperation>(null);
  let asking = $state<"restart" | "rebuild" | null>(null);
  /** An action's error, under the row it came from. */
  let failure = $state<{ at: "workshop" | "machine"; text: string } | null>(null);
  // The host runs one operation at a time: a remounted page or another window sees it and waits for its end.
  /** Set while Docker is missing: tells an installed app that is stopped from none at all. */
  let docker = $state<DockerStatus | null>(null);
  let startingDocker = $state(false);
  /** Ressac's workshop machine; null where it cannot run (the Docker texts then). */
  let machine = $state<MachineShown | null>(null);
  let usage = $state<{ memoryMB: number; diskMB: number } | null>(null);
  let askingMachine = $state<"remove" | "force" | "switch" | null>(null);
  let loads = 0;
  const loadWorkshop = async () => {
    // A load started before an action (a removal) may answer after the one started after it: only the latest one shows.
    const n = ++loads;
    const [w, op, m] = await Promise.all([s.workshop(), s.workshopOperation(), s.machine()]);
    if (n !== loads) return;
    const shown = m && m.kind !== "unsupported" ? m : null;
    const u = shown?.kind === "running" || shown?.kind === "stopped" ? await s.machineUsage() : null;
    if (n !== loads) return;
    [machine, usage, workshop, operation] = [shown, u, w, op];
    docker = workshop === "docker-absent" ? await s.docker() : null;
  };
  // Polled while its state can change on its own: a download or start, an install AI on may begin, a hand-over waiting.
  const machineChanging = $derived(machine?.kind === "downloading" || machine?.kind === "starting" || (machine?.kind === "absent" && !machine.removed && aiOn()) || !!machine?.waiting);
  const gb = (mb: number) => Math.round((mb / 1024) * 10) / 10;
  const MACHINE_TEXT = { running: "settings-workshop-machine-running", stopped: "settings-workshop-machine-stopped", starting: "settings-workshop-machine-starting", absent: "settings-workshop-machine-absent", error: "settings-workshop-machine-error" };
  const machineText = (m: MachineStatus) =>
    m.kind === "downloading"
      ? m.percent === null ? t("settings-workshop-machine-downloading-unknown") : t("settings-workshop-machine-downloading", { percent: m.percent })
      : m.kind === "absent" && m.removed ? t("settings-workshop-machine-removed")
      : t(MACHINE_TEXT[m.kind as keyof typeof MACHINE_TEXT]);
  /** A retry or removal in flight (minutes: a download, an export): the row's buttons wait, its state is polled. */
  let machineBusy = $state(false);
  /** `f` is bound before the call: closing the confirmation changes what it shows. */
  async function machineAct(f: () => Promise<{ ok: true } | { ok: false; error: string }>) {
    askingMachine = null;
    failure = null;
    machineBusy = true;
    const call = f();
    void loadWorkshop();
    const r = await call;
    machineBusy = false;
    await loadWorkshop();
    // A machine in error says it in its row already.
    if (!r.ok && machine?.kind !== "error") failure = { at: "machine", text: r.error };
  }
  async function startDocker() {
    startingDocker = true;
    const r = await s.startDocker();
    startingDocker = false;
    failure = r.ok ? null : { at: "workshop", text: r.error };
    await loadWorkshop();
  }
  $effect(() => void (aiOn() && loadWorkshop()));
  $effect(() => {
    if (!operation && !machineChanging && !machineBusy) return;
    const t = setInterval(() => void loadWorkshop(), 2_000);
    return () => clearInterval(t);
  });
  const WORKSHOP: Record<WorkshopState, string> = {
    started: "settings-workshop-started",
    stopped: "settings-workshop-stopped",
    absent: "settings-workshop-absent",
    "docker-absent": "settings-workshop-docker-absent",
    "machine-stopped": "settings-workshop-stopped",
  };
  const WORKSHOP_TONE: Record<WorkshopState, string> = { started: "ok", stopped: "off", absent: "off", "docker-absent": "warn", "machine-stopped": "off" };
  const CONFIRM = { restart: "settings-workshop-confirm-restart", rebuild: "settings-workshop-confirm-rebuild" };
  async function operate(kind: "restart" | "rebuild") {
    asking = null;
    failure = null;
    operation = kind;
    const r = await s.restartWorkshop(kind === "rebuild");
    operation = null;
    if (!r.ok) failure = { at: "workshop", text: r.error };
    void loadWorkshop();
  }
  const removable = $derived(machine && (machine.kind === "running" || machine.kind === "stopped" || (machine.kind === "error" && machine.forceRemovable)));
</script>

{#snippet failed(at: "workshop" | "machine")}
  {#if failure?.at === at}<span class="alert appear" role="status">{failure.text}</span>{/if}
{/snippet}

<section data-testid="settings-workshop" aria-label={t("settings-section-workshop")}>
  {#if !aiOn()}
    <AiAsleep feature="settings" />
  {:else if workshop === undefined}
    <p class="status"><span class="pill" data-tone="warn">{t("settings-checking")}</span></p>
  {:else}
    <div class="group">
      <SettingsRow label={t("settings-workshop-name")}>
        <span class="pill" data-tone={operation ? "warn" : workshop ? WORKSHOP_TONE[workshop] : "error"} data-testid="workshop-state">
          {operation === "restart" ? t("settings-workshop-restarting") : operation === "rebuild" ? t("settings-workshop-rebuilding") : workshop ? t(WORKSHOP[workshop]) : t("settings-agent-silent")}
        </span>
        {#if workshop === "docker-absent" && docker?.kind === "stopped"}
          <button class="primary" data-testid="docker-start" disabled={startingDocker} onclick={() => void startDocker()}>{startingDocker ? t("settings-starting") : t("settings-docker-start", { app: docker.app })}</button>
        {:else if workshop === "docker-absent"}
          <button class="primary" onclick={() => s.openUrl("https://orbstack.dev/download")}>{t("settings-docker-install")}</button>
        {/if}
        <button data-testid="workshop-restart" disabled={!!operation} onclick={() => (asking = "restart")}>{t("settings-restart")}</button>
        <button data-testid="workshop-rebuild" disabled={!!operation} onclick={() => (asking = "rebuild")}>{t("settings-rebuild")}</button>
        {#snippet below()}
          {@render failed("workshop")}
          {#if asking && !operation}
            {@const kind = asking}
            <div class="confirmation" role="alertdialog" aria-label={kind === "restart" ? t("settings-restart") : t("settings-rebuild")} out:fade={{ duration: 150 }}>
              <p>{t(CONFIRM[kind])}</p>
              <div class="buttons">
                <button onclick={() => (asking = null)}>{t("settings-cancel")}</button>
                <button class="primary" data-testid="confirm-workshop" onclick={() => void operate(kind)}>{kind === "restart" ? t("settings-restart") : t("settings-rebuild")}</button>
              </div>
            </div>
          {/if}
        {/snippet}
      </SettingsRow>
      {#if machine}
        <div class="appear" out:fade={{ duration: 150 }}>
          <SettingsRow label={t("settings-workshop-machine-label")} testid="machine">
            <span class="state" data-testid="machine-state">{machineText(machine)}</span>
            {#if machine.kind === "error"}
              <button data-testid="machine-retry" disabled={machineBusy} onclick={() => void machineAct(s.machineInstall)}>{t("settings-workshop-machine-retry")}</button>
            {:else if machine.kind === "absent" && machine.removed}
              <button class="appear" data-testid="machine-install" disabled={machineBusy} onclick={() => void machineAct(s.machineInstall)} out:fade={{ duration: 150 }}>{t("settings-workshop-machine-install")}</button>
            {:else if machine.waiting && (machine.kind === "running" || machine.kind === "stopped")}
              <button class="appear" data-testid="machine-switch" disabled={!!operation || machineBusy} onclick={() => (askingMachine = "switch")} out:fade={{ duration: 150 }}>{t("settings-workshop-machine-switch")}</button>
            {/if}
            {#snippet below()}
              {#if machine?.kind === "error"}<span class="alert appear" out:fade={{ duration: 150 }}>{machine.message}</span>{/if}
              {#if machine?.waiting}<span class="help appear" data-testid="machine-waiting" out:fade={{ duration: 150 }}>{t("settings-workshop-machine-waiting")}</span>{/if}
              {#if usage}<span class="help appear" data-testid="machine-usage" out:fade={{ duration: 150 }}>{machine?.kind === "running" ? t("settings-workshop-machine-usage", { memory: gb(usage.memoryMB), disk: gb(usage.diskMB) }) : t("settings-workshop-machine-usage-disk", { disk: gb(usage.diskMB) })}</span>{/if}
              {@render failed("machine")}
              {#if askingMachine === "switch" && !machineBusy}
                <div class="confirmation" role="alertdialog" aria-label={t("settings-workshop-machine-switch")} out:fade={{ duration: 150 }}>
                  <p>{t("settings-workshop-machine-confirm-switch")}</p>
                  <div class="buttons">
                    <button onclick={() => (askingMachine = null)}>{t("settings-cancel")}</button>
                    <button class="primary" data-testid="confirm-machine-switch" onclick={() => void machineAct(s.machineSwitchNow)}>{t("settings-workshop-machine-switch")}</button>
                  </div>
                </div>
              {/if}
            {/snippet}
          </SettingsRow>
        </div>
        <div class="appear" out:fade={{ duration: 150 }}>
          <SettingsRow label={t("settings-workshop-machine-idle-label")} id="settings-machine-idle" help={t("settings-workshop-machine-idle-help")}>
            <select id="settings-machine-idle" data-testid="machine-idle" aria-describedby="settings-machine-idle-help" value={appState.value?.settings.machineIdleMinutes ?? 5} onchange={(e) => api.dispatch({ type: "chooseMachineIdle", minutes: Number(e.currentTarget.value) as MachineIdleMinutes })}>
              {#each MACHINE_IDLE_MINUTES as minutes (minutes)}<option value={minutes}>{t("settings-workshop-machine-idle-option", { minutes })}</option>{/each}
            </select>
          </SettingsRow>
        </div>
      {/if}
    </div>
    {#if removable && machine}
      {@const force = machine.kind === "error"}
      <div class="appear" out:fade={{ duration: 150 }}>
        <h3 class="group-title">{t("settings-danger")}</h3>
        <div class="group danger-zone">
          <SettingsRow label={t("settings-workshop-machine-label")} help={force ? undefined : t("settings-workshop-machine-remove-help")}>
            {#if force}
              <button class="danger" data-testid="machine-force-remove" disabled={machineBusy} onclick={() => (askingMachine = "force")}>{t("settings-workshop-machine-force-remove")}</button>
            {:else}
              <button class="danger" data-testid="machine-remove" disabled={!!operation || machineBusy} onclick={() => (askingMachine = "remove")}>{t("settings-workshop-machine-remove")}</button>
            {/if}
            {#snippet below()}
              {#if (askingMachine === "remove" || askingMachine === "force") && !machineBusy}
                <div class="confirmation" role="alertdialog" aria-label={t(force ? "settings-workshop-machine-force-remove" : "settings-workshop-machine-remove")} out:fade={{ duration: 150 }}>
                  <p>{t(force ? "settings-workshop-machine-confirm-force-remove" : "settings-workshop-machine-confirm-remove")}</p>
                  <div class="buttons">
                    <button onclick={() => (askingMachine = null)}>{t("settings-cancel")}</button>
                    <button class="primary" data-testid="confirm-machine" onclick={() => void machineAct(s.machineRemove.bind(null, force))}>{t(force ? "settings-workshop-machine-force-remove" : "settings-workshop-machine-remove")}</button>
                  </div>
                </div>
              {/if}
            {/snippet}
          </SettingsRow>
        </div>
      </div>
    {/if}
  {/if}
</section>
