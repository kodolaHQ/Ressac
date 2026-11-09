import type { AgentHost } from "../agent/host";

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
 * The kernel host is Node and cannot call Cc: it sends `accueil.notification` over the RPC. The alert goes through the
 * system alerts service only (note P4: `Services.alerts` does not exist, and the XUL fallback opens a window).
 */
export function registerHomeNotifications(agent: Pick<AgentHost, "on">): () => void {
  return agent.on("accueil.notification", (n: { titre?: unknown; texte?: unknown }) => {
    try {
      const alert = Cc["@mozilla.org/alert-notification;1"].createInstance(Ci.nsIAlertNotification);
      // A unique name: an alert with the same name replaces the previous one.
      alert.init(`webaios-accueil-${Date.now()}`, "", String(n?.titre ?? "WebAiOs"), String(n?.texte ?? ""), false, "");
      // nsIObserver is a function interface: a plain function stands for it.
      Cc["@mozilla.org/alerts-service;1"].getService(Ci.nsIAlertsService).showAlert(alert, (s: unknown, t: string, d: string) => alertObserver.observe(s, t, d));
    } catch (e) {
      console.error("[webaios] notification non montrée :", e);
    }
  });
}
