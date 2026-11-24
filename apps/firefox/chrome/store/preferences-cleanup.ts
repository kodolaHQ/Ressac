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
  // Tabs and their layout: the store manages them.
  "tabs",
  "browserLayout",
  // Firefox's updates and profiles have no meaning here.
  "updates",
  "profiles",
  // Ressac keeps its own history.
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

/** Single rows of groups Ressac keeps. */
export const HIDDEN_CONTROLS = [
  // Mozilla's services: Firefox Relay (e-mail masks, with a Mozilla account) beside GPC and DNT, Mozilla Monitor's breach alerts.
  "relayIntegration",
  "trustPanelBreachAlertsMain",
  // Firefox's AI: key points of a link preview, « ask a chatbot » on a selection. The agent is Ressac's.
  "linkPreviewKeyPoints",
  "highlightToSearchAskChatbot",
];

/** The stylesheet, for the preferences pages only. */
export function preferencesSheet(): string {
  const selectors = [
    ...HIDDEN_CATEGORIES.map((id) => `#${id}`),
    ...[...Object.values(CATEGORIES), ...HIDDEN_PANES].map((pane) => `[data-category="${pane}"]`),
    // A group not yet migrated to setting-group is a groupbox naming it.
    ...HIDDEN_GROUPS.flatMap((g) => [`setting-group[groupid="${g}"]`, `[data-srd-groupid="${g}"]`]),
    ...HIDDEN_CONTROLS.map((id) => `#${id}`),
  ];
  return `@-moz-document url-prefix("about:preferences"), url-prefix("about:settings") {\n${selectors.join(",\n")} { display: none !important }\n}\n`;
}

export function installPreferencesCleanup(): void {
  const prefs = Services.prefs.getDefaultBranch("");
  // Firefox 161 locks the redesigned page on; it opens on the account pane, hidden above, so Ressac opens it on
  // #privacy (ui/settings-api.ts openAdvanced).
  prefs.setBoolPref("identity.fxaccounts.enabled", false);
  prefs.setBoolPref("browser.preferences.moreFromMozilla", false);
  const sss = Cc["@mozilla.org/content/style-sheet-service;1"].getService(Ci.nsIStyleSheetService);
  const uri = Services.io.newURI(`data:text/css,${encodeURIComponent(preferencesSheet())}`);
  if (!sss.sheetRegistered(uri, sss.USER_SHEET)) sss.loadAndRegisterSheet(uri, sss.USER_SHEET);
}
