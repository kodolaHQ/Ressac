import type { AgentHost } from "../agent/host";
import { testEnv } from "../test-env";

/** A click on a notification: the last used window is restored and focused, its tab unchanged. */
export function focusRecentWindow(wm = Services.wm): void {
  // With no window left, nothing happens: Firefox keeps none to reopen here.
  const w = wm.getMostRecentBrowserWindow();
  if (!w) return;
  if (w.windowState === w.STATE_MINIMIZED) w.restore();
  w.focus();
}

/** The alerts' observer: only a click acts (alertshow and alertfinished are ignored). */
export const alertObserver = {
  observe(_subject: unknown, topic: string, _data: string): void {
    if (topic === "alertclickcallback") focusRecentWindow();
  },
};

/**
 * A macOS notification, through the system alerts service only (note P4: `Services.alerts` does not exist, and the XUL
 * fallback opens a window). Under RESSAC_TEST_NOTIFICATIONS it is written to that file instead, like the host does.
 */
export function showAlert(title: string, text: string): void {
  const file = testEnv("RESSAC_TEST_NOTIFICATIONS");
  if (file) return void IOUtils.writeUTF8(file, JSON.stringify({ title, text }) + "\n", { mode: "appendOrCreate" }).catch((e: unknown) => console.error("[ressac] notification not written:", e));
  try {
    const alert = Cc["@mozilla.org/alert-notification;1"].createInstance(Ci.nsIAlertNotification);
    // A unique name: an alert with the same name replaces the previous one.
    alert.init(`ressac-home-${Date.now()}`, "", title, text, false, "");
    // nsIObserver is a function interface: a plain function stands for it.
    Cc["@mozilla.org/alerts-service;1"].getService(Ci.nsIAlertsService).showAlert(alert, (s: unknown, t: string, d: string) => alertObserver.observe(s, t, d));
  } catch (e) {
    console.error("[ressac] notification not shown:", e);
  }
}

/** The kernel host is Node and cannot call Cc: it sends `home.notification` over the RPC. */
export function registerHomeNotifications(agent: Pick<AgentHost, "on">): () => void {
  return agent.on("home.notification", (n: { title?: unknown; text?: unknown }) => showAlert(String(n?.title ?? "Ressac"), String(n?.text ?? "")));
}
