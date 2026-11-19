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
];

const SEGMENTS = new Set([
  "settings", "account", "myaccount", "compte", "espace-client", "espace-particulier", "security", "login", "signin",
]);

export function isSensitive(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol === "about:") return /^(logins|preferences)$/.test(u.pathname);
  const host = u.hostname.toLowerCase();
  if (HOSTS.some((d) => host === d || host.endsWith("." + d))) return true;
  const parts = u.pathname.toLowerCase().split("/").filter(Boolean);
  if (parts.some((p) => SEGMENTS.has(p))) return true;
  return parts.includes("billing") && !host.startsWith("docs.") && !parts.includes("docs");
}
