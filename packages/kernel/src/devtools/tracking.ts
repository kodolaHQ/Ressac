import type { AccessPolicy } from "../access/policy.js";
import { DevToolsBusy, type TabInfo, type BrowserDevTools } from "../mcp/bridge.js";

function originOf(url: string): string | null {
  try {
    const o = new URL(url).origin;
    return o === "null" ? null : o;
  } catch {
    return null;
  }
}

/**
 * Attaches the dev tools to the tabs that have at least one right, and detaches them when they no longer have any
 * (spec §8): console/network collection starts at attachment and its buffers are emptied at detachment. A tab
 * that keeps its rights on another origin (app relaunched on another port, demo moved by the agent) is
 * reattached: its buffers restart on the new page instead of failing on the first call.
 */
export class DevToolsTracking {
  readonly attaches = new Set<string>();
  /** Origin of each tab when it was attached. */
  private readonly origins = new Map<string, string | null>();
  /** Tabs where the user opened their own tools: the attachment failed. */
  readonly busy = new Set<string>();
  private file: Promise<void> = Promise.resolve();
  private scheduled = false;
  private stopped = false;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly policy: AccessPolicy,
    private readonly tools: BrowserDevTools,
    private readonly tabs: () => Promise<TabInfo[]>,
  ) {
    this.unsubscribe = policy.onChange(() => this.schedule());
    this.schedule();
  }

  /** Only one reconciliation at a time; the changes that happen while it runs trigger a single one. */
  private schedule(): void {
    if (this.scheduled || this.stopped) return;
    this.scheduled = true;
    this.file = this.file
      .then(() => {
        this.scheduled = false;
        return this.stopped ? undefined : this.reconcile();
      })
      .catch(() => {});
  }

  private async reconcile(): Promise<void> {
    const tabs = (await this.tabs()).filter((o) => this.policy.devRights(o).length);
    const wanted = new Map(tabs.map((o) => [o.id, originOf(o.url)]));
    for (const [id, origin] of wanted) {
      if (this.attaches.has(id)) {
        if (this.origins.get(id) === origin) continue;
        // Same tab, other origin: we restart from the displayed page.
        this.attaches.delete(id);
        this.origins.delete(id);
        await this.tools.detach(id).catch(() => {});
      }
      try {
        await this.tools.attach(id);
        this.attaches.add(id);
        this.origins.set(id, origin);
        this.busy.delete(id);
      } catch (e) {
        if (e instanceof DevToolsBusy) this.busy.add(id);
      }
    }
    for (const id of [...this.attaches]) {
      if (wanted.has(id)) continue;
      this.attaches.delete(id);
      this.origins.delete(id);
      await this.tools.detach(id).catch(() => {});
    }
    for (const id of [...this.busy]) if (!wanted.has(id)) this.busy.delete(id);
  }

  stop(): void {
    this.stopped = true;
    this.unsubscribe();
    for (const id of this.attaches) void this.tools.detach(id).catch(() => {});
    this.attaches.clear();
    this.origins.clear();
    this.busy.clear();
  }
}
