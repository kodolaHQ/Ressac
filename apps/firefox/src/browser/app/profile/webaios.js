/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// WebAiOs default prefs, included at the end of firefox.js.

// Browser developer tools (for developers and agents); remote connections still ask for confirmation.
pref("devtools.chrome.enabled", true);
pref("devtools.debugger.remote-enabled", true);
pref("devtools.debugger.prompt-connection", true);

// Native macOS title bar: Firefox's tab strip is hidden behind our own UI.
pref("browser.tabs.inTitlebar", 0);

// No first-run screens.
pref("browser.shell.checkDefaultBrowser", false);
pref("browser.aboutwelcome.enabled", false);
pref("browser.startup.homepage_override.mstone", "ignore");
pref("startup.homepage_welcome_url", "");
pref("datareporting.policy.dataSubmissionEnabled", false);
pref("browser.migrate.showBookmarksToolbarAfterMigration", false);
