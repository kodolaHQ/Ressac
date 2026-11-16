# Firefox-side texts: banners, import, site windows, extensions, menus.

# Import from another browser (end notification, errors).
chrome-import-count-bookmarks = { $count ->
    [one] { $shown } bookmark
   *[other] { $shown } bookmarks
}
chrome-import-count-history = { $count ->
    [one] { $shown } history page
   *[other] { $shown } history pages
}
chrome-import-count-passwords = { $count ->
    [one] { $shown } password
   *[other] { $shown } passwords
}
chrome-import-count-spaces = { $count ->
    [one] { $shown } sidebar item
   *[other] { $shown } sidebar items
}
chrome-import-count-tabs = { $count ->
    [one] { $shown } open tab
   *[other] { $shown } open tabs
}
chrome-import-type-bookmarks = bookmarks
chrome-import-type-history = history
chrome-import-type-passwords = passwords
chrome-import-type-spaces = spaces and pinned tabs
chrome-import-type-tabs = open tabs
chrome-import-partial = Import partly done
chrome-import-done = Import done
chrome-import-not-imported = Not imported: { $failed }
chrome-import-safari-denied = access denied: allow Ressac in System Settings › Privacy & Security › Full Disk Access
chrome-import-access-denied = macOS refused access: allow Ressac in System Settings › Privacy & Security › Files and Folders
chrome-import-access-cancelled = Access not granted: without it, Ressac cannot read { $name }'s data.
chrome-import-access-wrong = macOS still refuses access to { $name }'s data. Choose the suggested folder, or allow Ressac in System Settings › Privacy & Security › Files and Folders.
chrome-import-access-first = First allow access to { $name }'s data
chrome-import-keychain-denied = keychain access denied
chrome-import-profile-unreadable = { $name } profile unreadable
chrome-import-file-unreadable = file unreadable: quit { $name } and try again
chrome-import-no-zen-profile = Zen profile not found
chrome-import-no-space = no space found
chrome-import-format = { $name } format not recognized
chrome-import-keychain-test = keychain not read during tests
chrome-import-running = An import is already running
chrome-import-no-browser = That browser is not on this Mac
chrome-import-nothing = Nothing to import
chrome-import-no-profile = Profile not found
chrome-import-csv-pick = Choose your passwords export (CSV)
chrome-import-no-file = No file chosen
chrome-import-csv-unreadable = That file could not be read.
chrome-import-csv-invalid = That file is not a passwords export (CSV).

# A site's permission request banner.
chrome-banner = { $site } wants to { $what }
chrome-banner-link = { $text }: { $link }
chrome-banner-label = Permission request
chrome-banner-deny = Deny
chrome-banner-allow = Allow
chrome-perm-use = use { $what }
chrome-perm-media-camera = your camera
chrome-perm-media-micro = your microphone
chrome-perm-notifications = send you notifications
chrome-perm-geolocation = know your location
chrome-perm-fullscreen = go full screen
chrome-perm-clipboard-sanitized-write = write to the clipboard
chrome-perm-open-app = open a link in another application
chrome-perm-read-tab = read a tab
chrome-perm-devtools = use the developer tools
chrome-perm-widget-data = see a widget's data
chrome-perm-extension = turn on an extension
chrome-perm-extension-console = see an extension's whole console
chrome-perm-agent-address = open an address written by the agent
chrome-perm-other = an unknown permission
chrome-perm-screen-share = share your screen
chrome-perm-drm = play protected content (DRM)
chrome-perm-midi = use your MIDI devices

# The « Navigation » menu and the agent's search band.
chrome-menu-navigation = Navigation
chrome-menu-forget-permissions = Forget this site's permissions
chrome-search-label = Agent search
chrome-search-continue = Continue
chrome-search-stop = Stop
chrome-search-close = Close
chrome-search-stats = { $pages ->
    [one] { $pages } page read
   *[other] { $pages } pages read
} · { $duration }
chrome-duration-seconds = { $s } s
chrome-duration-minutes = { $m } min { $s }

# Start-up notifications and the confirmation before leaving a site.
chrome-session-set-aside = Ressac is starting with a fresh session. The old one is kept in { $path }
chrome-data-reset = Ressac is starting fresh. Its old data is kept in { $backup } (Settings › Data). Your projects haven't moved.
chrome-data-unknown-format = Ressac doesn't recognize the format of its data: it is starting fresh and keeps them in { $backup }. Your projects haven't moved.
chrome-telemetry-stop = Stop sending
chrome-telemetry-ok = OK
chrome-leave-title = Leave this site?
chrome-leave-text = Changes you made may not be saved.
chrome-leave-leave = Leave
chrome-leave-stay = Stay

# Design mode: where it does not work, and the capture warning of a site app.
chrome-design-unavailable = Design mode works on the agent's apps, site apps and projects connected through a Claude Code
chrome-design-unavailable-site = Design mode works in the site's pages and on its home, not on the grant card, a sign-in page or in full screen
chrome-design-capture-warning = The excerpt and the capture of this element will go to the agent.

# A site app's window: bar, grant card, home.
chrome-site-back = Back
chrome-site-forward = Forward
chrome-site-home = App home
chrome-site-reload = Reload
chrome-site-search-address = Look for the new address
chrome-site-link-blocked = Link to { $domain } blocked
chrome-site-open-tab = Open in a tab
chrome-site-enter = Enter the site
chrome-site-design = Design mode
chrome-site-design-title = Design mode ({ $shortcut })
chrome-site-design-menu = Design mode menu
chrome-site-basket = Basket
chrome-site-review = See the agent's changes
chrome-grant-title = Allow the tweaks of "{ $name }"?
chrome-grant-domains = Domains
chrome-grant-tracked = Tracked addresses
chrome-grant-sign-in = Sign-in
chrome-grant-frames = Frames
chrome-grant-injects = Injects
chrome-grant-resume = Resumes videos where you left off
chrome-grant-warning = Its tweaks see and modify the pages of these domains. An image added to the page can still send data to another site.
chrome-grant-refuse = Open without tweaks
chrome-grant-allow = Allow

# Titles of the internal pages' tabs.
chrome-page-settings = Settings
chrome-page-release-notes = What's new
chrome-page-workflow = Workflow — { $name }
chrome-page-review = Review — { $name }

# Actions: the interface's answers when the service does not respond.
chrome-actions-no-kernel = The actions service is not responding (agent stopped?)
chrome-actions-profile-refused = That profile can't be used for a grant

# Address bar, essentials, ⌃Tab panel, the agent's pill, an app's badge, page errors.
chrome-ui-back = Back
chrome-ui-forward = Forward
chrome-ui-stop = Stop
chrome-ui-reload = Reload
chrome-ui-compact = Compact mode
chrome-ui-compact-leave = Leave compact mode
chrome-ui-address = Search or enter an address
chrome-ui-essentials = Essentials
chrome-ui-unload = Unload
chrome-ui-remove = Remove
chrome-ui-recent-tabs = Recent tabs
chrome-ui-page-error = Couldn't open this page.
chrome-ui-page-crashed = This page crashed.
chrome-ui-unmute = Unmute the tab
chrome-ui-mute = Mute the tab
chrome-ui-access = The agent's access to this tab
chrome-ui-widget-unreadable = Unreadable widget: { $reason }
chrome-ui-loading = Loading…
chrome-ui-widget-preview = Preview: data not kept in this run
chrome-badge-basket = Basket ({ $count })
chrome-pill-open = See the agent's tab
chrome-pill-grow = Enlarge
chrome-pill-reduce = Reduce
chrome-pill-hide = Hide

# The vim mode in pages.
chrome-vim-paused = vim paused · ⇧Esc to resume
chrome-host-stopped = The agent kernel stopped.
chrome-display-denied = Display refused: it contains &lt;link&gt;, &lt;meta http-equiv&gt; or speculation rules, which would send data out. See guides/widgets.md.
