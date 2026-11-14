/**
 * Firefox menu items that compete with Ressac's own features (profiles, containers outside a space, private windows,
 * bookmarks, session restore, import, Firefox View, toolbar customizing, Mozilla's Help menu). Hidden rather than
 * disabled: the macOS menu bar honours `hidden`, and Firefox builds some of them without a command.
 */
export const FIREFOX_HIDDEN_ITEMS = [
  "profiles-menu",
  "menu_newUserContext",
  "context-openlinkinusercontext-menu",
  "context-openlinkprivate",
  "context-searchselect-private",
  "bookmarksMenu",
  "context-bookmarkpage",
  "context-bookmarklink",
  "context-bookmarkframe",
  "historyRestoreLastSession",
  "historyUndoWindowMenu",
  "menu_importFromAnotherBrowser",
  "menu_openFirefoxView",
  "menu_customizeToolbars",
  // Help: everything but « À propos » (macOS moves it into the app menu).
  "menu_openHelp",
  "help_reportBrokenSite",
  "feedbackPage",
  "helpSafeMode",
  "troubleShooting",
  "menu_HelpPopup_reportPhishingtoolmenu",
  "menu_HelpPopup_reportPhishingErrortoolmenu",
  "helpSwitchDevice",
  "aboutSeparator",
];

/**
 * Hides FIREFOX_HIDDEN_ITEMS now and on every popupshowing: Firefox re-shows some (nsContextMenu, profiles) while its menu
 * opens, from a listener on the popup set; ours, on the window in the bubble phase, runs after it.
 */
export function hideFirefoxItems(win: Window): () => void {
  const hide = () => {
    for (const id of FIREFOX_HIDDEN_ITEMS) {
      const el = win.document.getElementById(id);
      if (el) el.hidden = true;
    }
  };
  hide();
  // The Dock menu lives in the hidden window; « Nouvelle fenêtre privée » would open a plain Firefox window.
  const dock = Services.appShell.hiddenDOMWindow?.document.getElementById("macDockMenuNewPrivateWindow");
  if (dock) dock.hidden = true;
  win.addEventListener("popupshowing", hide);
  return () => win.removeEventListener("popupshowing", hide);
}
