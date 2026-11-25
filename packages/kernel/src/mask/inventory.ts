/**
 * What each MCP tool does with data, for the lock after a reveal (spec § 3). Closed: a test fails on a registered tool
 * missing here, so a new tool is classified before it ships; a tool missing at run time counts as an outflow with no
 * destination (fail closed).
 * - `outflow`: sends to a destination the kernel knows (an address, a field's origin);
 * - `outflow-no-destination`: sends somewhere the kernel cannot name (an engine, an action, a page's script);
 * - `store-write`: writes to a store that outlives the conversation (Task 10 refuses them while locked);
 * - `read`: everything else.
 */
export type ToolKind = "outflow" | "outflow-no-destination" | "read" | "store-write";

const kinds = (kind: ToolKind, names: string[]) => Object.fromEntries(names.map((n) => [n, kind]));

export const TOOL_KINDS: Readonly<Record<string, ToolKind>> = Object.freeze({
  ...kinds("outflow", ["navigate", "open_tab", "read_pages", "fill_field"]),
  // run_js: a script in the page sends anywhere (ruling); reload: reruns a page the agent may have rewritten, with Firefox's network.
  ...kinds("outflow-no-destination", ["search_web", "open_site", "launch_app", "launch_action", "open_workflow", "hand_over", "run_js", "reload"]),
  ...kinds("store-write", ["note_lesson", "show_recap", "harvest_widget"]),
  ...kinds("read", [
    "reveal_value", "current_page", "list_tabs", "read_tab", "capture_screen", "stop_app", "app_log",
    "widget_data", "widget_runs", "action_runs", "read_recap", "list_sites", "close_site", "site_memory", "tweak_errors",
    "search_history", "read_history", "search_bookmarks",
    "request_devtools", "read_console", "read_network", "read_request", "profile_performance", "memory_snapshot", "compare_memory",
  ]),
});

/**
 * Every store that outlives a conversation (spec § 3), closed: `space` stores stay readable by the space's next
 * conversations, born locked; `shared` stores refuse every write while the workspace is locked (another space's
 * unlocked conversation would read them); `browser` stores are the browser's own, never agent-written.
 */
export type StoreId =
  | "workspace" | "agent-home" | "container-tmp" | "ressac-logs"
  | "notebook" | "site-memories" | "widget-data" | "action-results" | "workflow-runs" | "recaps" | "design-external"
  | "history" | "outflow-memory";

export const STORES: Readonly<Record<StoreId, "space" | "shared" | "browser">> = Object.freeze({
  // `agent-home`: /home/node; `container-tmp`: /tmp and /var/tmp.
  workspace: "space", "agent-home": "space", "container-tmp": "space", "ressac-logs": "space",
  notebook: "shared", "site-memories": "shared", "widget-data": "shared", "action-results": "shared", "workflow-runs": "shared",
  recaps: "shared", "design-external": "shared",
  history: "browser", "outflow-memory": "browser",
});

/** The stores each `store-write` tool writes (a test fails on a store-write tool missing here). */
export const TOOL_WRITES: Readonly<Record<string, StoreId[]>> = Object.freeze({
  note_lesson: ["notebook"],
  show_recap: ["recaps"],
  harvest_widget: ["widget-data"],
});
