# Home, first-launch welcome, import, Applications, permission cards.

home-cancel = Cancel
home-deny = Deny
home-allow = Allow
home-close = Close
home-delete = Delete
home-quoted = “{ $name }”
home-agent = the agent
home-agent-cap = The agent

## Welcome

home-welcome-label = Welcome to Ressac
home-welcome-tagline = A calm browser, with an agent when you want one.
home-welcome-start = Get started
home-welcome-continue = Continue
home-welcome-next = Next
home-welcome-resume = Back to the welcome
home-welcome-back = Back
home-welcome-later = Later
home-welcome-yes = Yes
home-welcome-done = Done
home-welcome-ai-ask-title = Turn on AI?
home-welcome-ai-ask-intro = An agent can work for you: it browses, searches, compares, builds apps and keeps your widgets up to date.
home-welcome-ai-ask-needs = It needs OrbStack (or Docker Desktop) and a Claude or ChatGPT account. Ressac also downloads two small local AI models (1.4 GB).
home-welcome-ai-ask-needs-machine = It needs a Claude or ChatGPT account. Ressac also downloads its workshop (about 500 MB) and two small local AI models (1.4 GB).
home-welcome-ai-ask-later = Without AI, Ressac stays a browser, and nothing runs in the background. You can turn it on later in Settings › Agent.
home-welcome-checking = Checking…
home-welcome-recheck = Check again
home-welcome-import-title = Coming from another browser?
home-welcome-sidebar-title = Your tabs live on the left
home-welcome-sidebar-tabs = The tabs of the current space, in a list.
home-welcome-sidebar-spaces = The spaces at the bottom: one per topic, each with its own aura.
home-welcome-sidebar-command = opens a tab or searches everywhere.
home-welcome-engine-title = Which search engine?
home-welcome-engine-intro = What you type in the bar, when it is not an address, goes to this engine.
home-welcome-engine-group = Search engine
home-welcome-engine-later = You can change it in Settings › General.
home-welcome-appearance-title = Light or dark?
home-welcome-appearance-later = You can change it in Settings › General.
home-welcome-agent-title = Connect an agent
home-welcome-agent-intro = Claude Code and Codex work in a separate container on your Mac. They need OrbStack (or Docker Desktop).
home-welcome-docker-stopped = { $app } is installed but not running.
home-welcome-docker-start = Start { $app }
home-welcome-docker-absent = OrbStack is not running or not installed.
home-welcome-docker-install = Install OrbStack
home-welcome-docker-unreachable = Can't check right now.
home-welcome-docker-ready = Docker is ready.
home-welcome-agent-intro-machine = Claude Code and Codex work in a separate workshop, a small machine Ressac downloads to your Mac (about 500 MB).
home-welcome-machine-downloading = Preparing the workshop… { $percent } %
home-welcome-machine-preparing = Preparing the workshop…
home-welcome-machine-ready = The workshop is ready: Ressac starts it when the agent needs it.
home-welcome-agent-group = Agent
home-welcome-agent-login = You will sign in the first time you open the agent ({ $key }).
home-welcome-ai-title = Local AI
home-welcome-ai-intro = A small AI runs on your Mac, alongside the agent. It is free and nothing it reads leaves your machine. It is used to:
home-welcome-ai-guard = watch the agent: it pauses it when one of its actions looks strange;
home-welcome-ai-triage = sort for you: when Ressac follows a topic on your behalf, it picks what deserves to be shown to you;
home-welcome-ai-search = find your pages by their meaning, when you ask a question with ⌘T.
home-welcome-ai-needs = It uses two models Ressac downloads for you: d1-2B (1.1 GB) to watch and sort, and EmbeddingGemma (334 MB) for search.
home-welcome-models-started = Download in progress. Progress is in Settings › Local AI.
home-welcome-models-missing = { $missing ->
    [decision] The local AI model d1-2B is missing (1.1 GB).
    [search] The search model EmbeddingGemma is missing (334 MB).
   *[both] The local AI models are missing (1.4 GB).
}
home-welcome-models-pull = Download in the background
home-welcome-models-ready = The models are installed.
home-welcome-models-unreachable = Can't check right now.
home-welcome-ready-title = All set
home-welcome-space-label = Your first space
home-welcome-aura-group = Aura
home-welcome-aura-choice = Aura { $name }
home-welcome-notifications-note = To receive alerts from sites and from the watch, allow Ressac's notifications in System Settings.
home-welcome-notifications-open = Open notification settings
home-welcome-finish = Open the browser
home-welcome-page = Page { $page } of { $total }

## Import from another browser

home-import-type-bookmarks = Bookmarks
home-import-type-history = History
home-import-type-passwords = Passwords
home-import-type-spaces = Spaces and pinned tabs
home-import-type-tabs = Open tabs
home-import-start-failed = The import could not start: { $reason }
home-import-csv-result = { $count ->
    [one] { $count } password imported
   *[other] { $count } passwords imported
}
home-import-safari-1 = Open the Passwords app.
home-import-safari-2 = File › Export All Passwords…
home-import-other-1 = In { $name }, open about:logins
home-import-other-2 = ⋯ › Export logins
home-import-guide-choose = Choose the file below.
home-import-guide-delete = Then delete the exported file: it is not encrypted.
home-import-checking = Checking…
home-import-none = No other browser found on this Mac.
home-import-browser = Browser
home-import-profile = Profile
home-import-passwords = Passwords
home-import-csv-pick = Choose the CSV file…
home-import-start = Import
home-import-done = Import finished.
home-import-started = Import started: a notification will tell you when it is done.
home-import-failed = { $type }: { $why }
home-import-disk-access = Open settings
home-import-access = macOS protects { $name }'s data. Click “Allow access”, then “Open” in the window that appears: it is already on the right folder.
home-import-access-grant = Allow access

## Release notes page

home-notes-title = What's new

## Permission cards

home-request-label-devtools = Request for access to the developer tools
home-request-label-action = Request for access to an action's results
home-request-label-site = Request for access to a site app
home-request-label-history = Request for access to your history
home-request-label-widget = Request for access to a widget's data
home-request-label-address = The agent wants to open an address it wrote itself
home-request-label-address-found = The agent wants to open a link it read on a page
home-request-label = Permission request
home-request-address-reason = Its reason: { $reason }
home-request-address-danger = ⚠ { $danger }
home-request-why = Why am I being asked this?
home-request-why-1 = The agent freely opens the links it finds in the pages it reads and in its search results. It found this address nowhere: it wrote it itself.
home-request-why-1-found = The agent opens the links it reads on pages freely. Ressac stopped this one for the reason in red above: it asks you first.
home-request-why-2 = A booby-trapped page can whisper an address to it that carries information off to an unknown site. A glance at the address and its reason is enough; when in doubt, “Deny”: the agent carries on another way.
home-request-widget-action = The agent wants to see the results of the action “{ $title }” (read with your account).
home-request-widget-site = The agent wants to see the site app “{ $title }” (signed in with your account): its pages and its memory, for this conversation.
home-request-history = The agent wants to search and read your history and bookmarks, for this conversation.
home-request-widget = The agent wants to see the data of the widget “{ $title }” (read with your account).
home-request-allow-conversation = Allow for this conversation
home-request-tab = The agent wants to read the tab “{ $title }”
home-request-allow-once = Allow once

home-devtools-title = { $agent } wants to access the developer tools
home-devtools-site = { $site } · tab “{ $tab }”
home-devtools-console = Console and errors
home-devtools-console-detail = Messages, JavaScript errors, warnings
home-devtools-network = Network
home-devtools-network-detail = The page's requests and responses
home-devtools-network-sensitive = may contain login data
home-devtools-performance = Performance and memory
home-devtools-performance-detail = Profiling, memory snapshots
home-devtools-act = Act on the page
home-devtools-act-detail = Run JavaScript, change the DOM, reload
home-devtools-act-sensitive = the agent can read everything the page holds, send it elsewhere without asking you, and act on your behalf on this site
home-devtools-allow = Allow the selection
home-devtools-note = Valid for this conversation · lapses if the tab changes site


## Applications page

home-apps-title = Applications
home-apps-filters = Filters
home-apps-group-type = Type
home-apps-group-state = State
home-apps-filter-all = All
home-apps-filter-app = Applications
home-apps-filter-poc = POCs and tests
home-apps-filter-no-manifest = No manifest
home-apps-filter-running = Running
home-apps-filter-stopped = Stopped
home-apps-filter-error = Failed
home-apps-type-app = Application
home-apps-type-poc = POC
home-apps-type-no-manifest = No manifest
home-apps-state-stopped = Stopped
home-apps-state-preparing = Preparing the workshop…
home-apps-state-launching = Launching…
home-apps-state-running = Running
home-apps-state-error = Failed
home-apps-today = today
home-apps-yesterday = yesterday
home-apps-days-ago = { $days }d ago
home-apps-from = from { $origin }
home-apps-port = port { $port }
home-apps-search = Search an app…
home-apps-no-docker = Docker is not running. The list stays visible, but no app can be launched.
home-apps-empty = Nothing here yet. Ask the agent to test a package or build an app.
home-apps-no-match = No app matches.
home-apps-more = More actions
home-apps-debug = Debug
home-apps-stop = Stop
home-apps-changes = Changes
home-apps-open = Open
home-apps-relaunch = Relaunch
home-apps-launch = Launch
home-apps-promote = Make it an application
home-apps-folder = Show the folder
home-apps-sites = Sites
home-apps-site-open = Open
home-apps-site-closed = Closed
home-apps-site-edit = Edit with the agent
home-apps-place-essentials = In the essentials
home-apps-place-bar = In the bar
home-apps-place-none = Nowhere
home-apps-site-forget = Forget what the app remembered
home-apps-forget-confirm = Forget everything “{ $name }” has remembered (series, video positions)?
home-apps-forget = Forget
home-apps-site-delete-confirm = Delete “{ $name }”? Its sign-in and its memory are erased, its folder goes to the trash.
home-apps-delete-confirm = Delete “{ $name }”? Its folder will be erased.

## External projects

home-external-title = External projects
home-external-ports = Ports { $ports }
home-external-no-client = no client
home-external-review = Changes
home-external-forget = Forget
home-external-connected-on = Connected on { $date }
home-external-revoke = Revoke
home-external-none = No Claude Code connected.
home-external-command = Paste this command in a terminal: it will not be shown again.
home-external-copied = Copied
home-external-copy = Copy
home-external-client-name = Client name
home-external-confirm = Connect
home-external-connect = Connect a Claude Code
home-external-failed = The connection failed.

## Home page

home-empty = No widgets yet. Ask the agent to create the first one.
home-no-effect = No effect for now: the widget service is not answering (agent stopped?).
home-grant-not-saved = Approval not saved: { $error }
home-remove-confirm = Remove “{ $name }” from the home page?
home-remove = Remove
home-widget-unreadable = Widget “{ $id }” unreadable: { $error }
home-widget-progress = updating… { $done } / { $total }
home-widget-updating = updating…
home-widget-failed = failed on { $date }: { $error }
home-widget-unknown-error = unknown error
home-widget-unknown-date = unknown date
home-widget-workshop-stopped = update impossible: workshop stopped
home-widget-next = next: { $next }
home-widget-options = Widget options
home-widget-update-now = Update now
home-widget-workflow = View / edit the workflow
home-widget-grant-public = This widget wants to read { $account } with your account, and will be able to contact: { $public }.
home-widget-grant-private = This widget wants to read { $account } with your account, and will contact no other site.
home-widget-allow = Allow…
home-widget-code-changed = The code changed since your approval.
home-widget-reads-public = This widget will read: { $public }
home-widget-reads-web = This widget searches and reads the web
home-widget-reads-public-web = This widget will read: { $public }, and searches and reads the web
home-widget-reads-allow = Allow
home-widget-resize = Resize
home-widget-no-display = The agent has not written this widget's display yet.

## Profile labels (grant cards, Settings › Privacy)

home-profile-of = Profile of “{ $spaces }”
home-profile = Profile “{ $id }”

# Masking cards (spec § 8): they name the value, never show it; « Voir » shows it here only.
home-request-label-mask-reveal = The agent wants to see a masked value
home-request-label-mask-fill = Fill a field with your data
home-request-label-mask-label-alert = The agent sends the label of a masked value
home-request-label-mask-devtools = Unlock the developer tools on a tab that shows your data
home-request-mask-domain = Site: { $domain }
home-request-mask-fill = Fill { $name } into « { $field } » on { $where }?
home-request-mask-devtools = Unlock the developer tools on { $site } (tab « { $tab } ») for this conversation?
home-request-mask-reveal-allow = Show
home-request-mask-fill-allow = Fill
home-request-mask-fill-remember-hint = On this site, the value will stay masked for the agent and fill without Touch ID.
home-request-mask-alert-allow = Send the label
home-request-mask-devtools-allow = Unlock for this conversation
home-request-mask-see = Show me
home-request-mask-hide = Hide
home-request-mask-see-address = Show the address
home-request-mask-hide-address = Hide the address
home-request-mask-logins = Login to fill
home-request-mask-login = Login { $n }
