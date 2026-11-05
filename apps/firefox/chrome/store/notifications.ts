import type { AgentHost } from "../agent/host";

/**
 * The noyau host is Node and cannot call Cc: it sends `accueil.notification` over the RPC. The alert goes through the
 * system alerts service only (note P4: `Services.alerts` does not exist, and the XUL fallback opens a window).
 */
export function registerAccueilNotifications(agent: Pick<AgentHost, "on">): () => void {
  return agent.on("accueil.notification", (n: { titre?: unknown; texte?: unknown }) => {
    try {
      const alert = Cc["@mozilla.org/alert-notification;1"].createInstance(Ci.nsIAlertNotification);
      // A unique name: an alert with the same name replaces the previous one.
      alert.init(`webaios-accueil-${Date.now()}`, "", String(n?.titre ?? "WebAiOs"), String(n?.texte ?? ""), false, "");
      const observer = { observe: () => {}, QueryInterface: ChromeUtils.generateQI(["nsIObserver"]) };
      Cc["@mozilla.org/alerts-service;1"].getService(Ci.nsIAlertsService).showAlert(alert, observer);
    } catch (e) {
      console.error("[webaios] notification non montrée :", e);
    }
  });
}
