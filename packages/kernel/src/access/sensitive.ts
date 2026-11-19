// Why: a granted site must still be re-asked before the agent reads a tab where a leak is costly
// (mail, bank, payroll, passwords, account settings).
// shortcut: hard-coded list, misses unlisted banks; let the user add sites if testers report misses
const HOSTS = [
  // webmail
  "mail.google.com", "outlook.live.com", "outlook.office.com", "outlook.office365.com", "mail.proton.me",
  "mail.yahoo.com", "icloud.com", "webmail.orange.fr", "messagerie.orange.fr", "webmail.sfr.fr", "imp.free.fr",
  // banks and neobanks
  "bnpparibas.net", "mabanque.bnpparibas", "societegenerale.fr", "credit-agricole.fr", "lcl.fr",
  "banquepopulaire.fr", "caisse-epargne.fr", "creditmutuel.fr", "cic.fr", "labanquepostale.fr",
  "boursobank.com", "fortuneo.fr", "hellobank.fr", "qonto.com", "shine.fr", "revolut.com", "n26.com", "nickel.eu",
  // payment
  "paypal.com", "lydia-app.com", "sumeria.eu", "dashboard.stripe.com",
  // payroll
  "payfit.com", "lucca.fr", "ilucca.net",
  // password managers
  "1password.com", "bitwarden.com", "dashlane.com", "lastpass.com", "pass.proton.me",
  // cloud consoles
  "console.aws.amazon.com", "console.cloud.google.com", "portal.azure.com",
  // tax, health, admin
  "impots.gouv.fr", "ameli.fr", "caf.fr", "franceconnect.gouv.fr", "urssaf.fr",
  // account pages
  "myaccount.google.com", "account.apple.com", "appleid.apple.com", "account.microsoft.com",
  // private messages and files
  "web.whatsapp.com", "messenger.com", "drive.google.com", "docs.google.com",
];

const SEGMENTS = new Set([
  "settings", "account", "myaccount", "compte", "espace-client", "espace-particulier", "security", "login", "signin",
]);

export function isSensitive(url: string, depth = 0): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  // these wrappers show the inner page: classify what they wrap (bounded so nesting cannot loop)
  if (u.protocol === "view-source:" || u.protocol === "blob:") return depth < 3 && isSensitive(u.pathname, depth + 1);
  if (u.protocol === "about:") return /^(logins|preferences)$/.test(u.pathname.toLowerCase());
  const host = u.hostname.toLowerCase().replace(/\.+$/, ""); // "mail.google.com." loads the same site
  if (HOSTS.some((d) => host === d || host.endsWith("." + d))) return true;
  const parts = u.pathname.toLowerCase().split("/").filter(Boolean);
  // a Slack workspace (app. or <team>.), not Slack's own site or API docs
  if (host.endsWith(".slack.com") && host !== "www.slack.com" && host !== "api.slack.com") return true;
  if (/(^|\.)linkedin\.com$/.test(host) && parts[0] === "messaging") return true;
  // Amazon orders, on any of its country domains
  if (/(^|\.)amazon\.[a-z]{2,3}(\.[a-z]{2})?$/.test(host) && ((parts[0] === "gp" && parts[1] === "your-account") || parts.includes("your-orders"))) return true;
  if (parts.some((p) => SEGMENTS.has(p))) return true;
  return parts.includes("billing") && !host.startsWith("docs.") && !parts.includes("docs");
}
