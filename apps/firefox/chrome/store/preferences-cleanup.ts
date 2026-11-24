// about:preferences (« Réglages avancés du navigateur ») without what contradicts Ressac: a user stylesheet hides it.

/** Navigation buttons, each with the pane it shows. */
const CATEGORIES: Record<string, string> = {
  // Firefox account and sync: Ressac keeps its own data.
  "category-sync": "paneSync",
  // Home page and startup: the store restores the spaces and their tabs.
  "category-home": "paneHome",
  // Firefox Labs: Mozilla's experiments.
  "category-experimental": "paneExperimental",
  // Firefox's version and updates: Ressac ships its own.
  "category-about-firefox": "paneAbout",
  // Mozilla's other products.
  "category-more-from-mozilla": "paneMoreFromMozilla",
  // Firefox's AI features: the agent is Ressac's.
  "category-ai-features": "paneAi",
  // Firefox 161: notifications, site permissions and data collection, all kept by Ressac (see HIDDEN_GROUPS).
  "category-permissions-data": "panePermissionsData",
};
export const HIDDEN_CATEGORIES = Object.keys(CATEGORIES);

/** Firefox 161's sub-panes with no button of their own, reached from a hidden pane or group. */
export const HIDDEN_PANES = [
  // Ressac keeps its own history.
  "paneHistory",
  // Profiles, the home page, Mozilla's VPN, and the AI « Smart Window » and its memories.
  "paneProfiles",
  "paneCustomHomepage",
  "paneVpnSiteRules",
  "panePersonalizeSmartWindow",
  "paneManageMemories",
];

export const HIDDEN_GROUPS = [
  // Startup, tabs and their layout: the store manages them.
  "startup",
  "tabs",
  "browserLayout",
  // Firefox's updates and profiles have no meaning here.
  "updates",
  "profiles",
  // Default browser: external links would open tabs outside the store.
  "defaultBrowser",
  // Ressac keeps its own history (« history2 » since Firefox 161).
  "history",
  "history2",
  // Site permissions are kept by Ressac (copied into Firefox), listed and revoked in its Settings page.
  "permissions",
  // Mozilla's data collection and services.
  "dataCollection",
  "backup",
  "ipprotection",
  "firefoxSuggest",
  "recommendations",
];

export const HIDDEN_CONTROLS = ["relayIntegration"];

/** The stylesheet, for the preferences pages only. */
export function preferencesSheet(): string {
  const selectors = [
    ...HIDDEN_CATEGORIES.map((id) => `#${id}`),
    ...[...Object.values(CATEGORIES), ...HIDDEN_PANES].map((pane) => `[data-category="${pane}"]`),
    // A group not yet migrated to setting-group is a groupbox naming it.
    ...HIDDEN_GROUPS.flatMap((g) => [`setting-group[groupid="${g}"]`, `[data-srd-groupid="${g}"]`]),
    // Firefox Relay (Mozilla's e-mail masks, with a Mozilla account), in Privacy since Firefox 161; its group keeps GPC and DNT.
    ...HIDDEN_CONTROLS.map((id) => `#${id}`),
  ];
  return `@-moz-document url-prefix("about:preferences"), url-prefix("about:settings") {\n${selectors.join(",\n")} { display: none !important }\n}\n`;
}

export function installPreferencesCleanup(): void {
  const prefs = Services.prefs.getDefaultBranch("");
  // The redesigned page opens on Firefox's account pane and shows it whatever identity.fxaccounts.enabled says; the
  // classic one opens on General, leaves out the account pane without accounts and keeps the ids hidden above.
  prefs.setBoolPref("browser.settings-redesign.enabled", false);
  prefs.setBoolPref("identity.fxaccounts.enabled", false);
  prefs.setBoolPref("browser.preferences.moreFromMozilla", false);
  const sss = Cc["@mozilla.org/content/style-sheet-service;1"].getService(Ci.nsIStyleSheetService);
  const uri = Services.io.newURI(`data:text/css,${encodeURIComponent(preferencesSheet())}`);
  if (!sss.sheetRegistered(uri, sss.USER_SHEET)) sss.loadAndRegisterSheet(uri, sss.USER_SHEET);
}
