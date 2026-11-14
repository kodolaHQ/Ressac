/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Replaces the file Surfer generates, whose start pages and update links point at Zen. This file loads after
// firefox.js (pref files load reverse-alphabetically), so a value set here would beat ressac.js: Ressac's own
// start and update prefs live in ressac.js, not here.

// Number of usages of the web console.
// If this is less than 5, then pasting code into the web console is disabled
pref("devtools.selfxss.count", 5);
