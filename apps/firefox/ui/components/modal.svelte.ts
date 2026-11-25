import type { BoundsRange } from "../../shared/api";
import type { PendingRequest } from "../../shared/model";

/**
 * Modal for an agent request, mounted at window level. `masqueurs`: number of mounted frozen backgrounds (modal,
 * ⌃Tab panel); above 0, the page's native view fades (it would cover them). `zone`: last bounds of the content area,
 * where to place the page's blurred capture.
 */
export const modal = $state<{ maskers: number; zone: BoundsRange | null }>({ maskers: 0, zone: null });

/**
 * The agent's requests (read, dev tools, widget data, masking) open as a modal; those from sites stay a banner.
 */
export const isAgentRequest = (d: PendingRequest) =>
  d.permissions.includes("read-tab") ||
  d.permissions.includes("devtools") ||
  d.permissions.includes("widget-data") ||
  d.permissions.includes("agent-address") ||
  d.permissions.some((p) => p.startsWith("mask-"));
