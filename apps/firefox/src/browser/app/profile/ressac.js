/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Ressac default prefs, included at the end of firefox.js.

// Browser developer tools (for developers and agents); remote connections still ask for confirmation.
pref("devtools.chrome.enabled", true);
pref("devtools.debugger.remote-enabled", true);
pref("devtools.debugger.prompt-connection", true);

// No title bar: the sidebar goes up to the top of the window, with the macOS window buttons in its first row.
pref("browser.tabs.inTitlebar", 1);

// No first-run screens.
pref("browser.shell.checkDefaultBrowser", false);
pref("browser.aboutwelcome.enabled", false);
pref("browser.startup.homepage_override.mstone", "ignore");
pref("startup.homepage_welcome_url", "");
pref("startup.homepage_welcome_url.additional", "");
pref("startup.homepage_override_url", "");
pref("datareporting.policy.dataSubmissionEnabled", false);
pref("browser.migrate.showBookmarksToolbarAfterMigration", false);

// Updates (the packaged app only: dev builds carry a DisableAppUpdate policy, Marionette sets app.update.disabledForTesting).
// Empty: nothing is published at a fixed download address (the feed is invite-only); Ressac's update card carries the link.
pref("app.update.url.manual", "");
pref("app.update.url.details", "");
// Checked every 12 h (the replaced branding prefs carried it).
pref("app.update.interval", 43200);
// A staged update waits for the user's « Redémarrer maintenant », never a restart behind their back.
pref("app.update.noWindowAutoRestart.enabled", false);
// Firefox's own update UI hangs off its hidden app menu: its badge never shows, and its restart doorhanger waits
// the longest a timer allows (24.8 days, in seconds; above it setTimeout fires at once). Ressac shows its own card.
pref("app.update.promptWaitTime", 2147483);
pref("app.update.notifyDuringDownload", false);

// Our tabs have a single source of truth (ours): no Firefox start page, new-tab page, session restore or tab-close behaviour.
pref("browser.startup.page", 0);
pref("browser.startup.homepage", "about:blank");
pref("browser.newtabpage.enabled", false);
pref("browser.sessionstore.resume_from_crash", false);
pref("browser.sessionstore.max_tabs_undo", 0);
pref("browser.tabs.closeWindowWithLastTab", false);
pref("browser.tabs.warnOnClose", false);
pref("browser.ctrlTab.sortByRecentlyUsed", false);
pref("browser.sessionstore.max_windows_undo", 0);

// Firefox features that compete with Ressac's own (the menu items are hidden by chrome/window/firefox-items.ts):
// a second profile, Firefox's sidebar, split view, its AI chat panel.
pref("browser.profiles.enabled", false);
pref("sidebar.revamp", false);
pref("sidebar.visibility", "hide-sidebar");
pref("browser.tabs.splitView.enabled", false);
pref("browser.ml.chat.enabled", false);

// AMO and many sites look for the Firefox/ token in the user agent: nsHttpHandler appends Firefox/<version> when this is on.
pref("general.useragent.compatMode.firefox", true);

// Crash and error reports (chrome/store/telemetry.ts): on unless turned off; the first-run notice says so once.
pref("ressac.telemetry.enabled", true);
pref("ressac.telemetry.noticeShown", false);

// A <link rel=dns-prefetch> would reach the web through DNS past the request guard of agent pages (chrome/agent/page-guard.ts).
pref("network.dns.disablePrefetch", true);
