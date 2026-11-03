/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Puts the WebAiOs sidebar on the left of the browser window. The sidebar is a privileged HTML page in an iframe:
// browser.xhtml defaults to the XUL namespace, where document.createElement would build XUL elements.
window.addEventListener(
  "DOMContentLoaded",
  () => {
    const frame = document.createElementNS("http://www.w3.org/1999/xhtml", "iframe") as HTMLIFrameElement;
    frame.id = "webaios-sidebar";
    frame.src = "chrome://browser/content/webaios/sidebar.html";
    document.getElementById("browser")!.prepend(frame);
  },
  { once: true }
);
