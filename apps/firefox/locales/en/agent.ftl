# Settings (agents, data, permissions, shortcuts, Mozilla account), agent panel, review, design mode.

## An agent's engine (Settings › Agent)

agent-engine-title = { $name } engine
agent-engine-next-session = A change applies to the next session; an open agent offers to restart.
agent-engine-kind-subscription = Claude subscription
agent-engine-kind-chatgpt = ChatGPT subscription
agent-engine-kind-api = Compatible API
agent-engine-kind-api-openai = OpenAI-compatible API
agent-engine-ollama-note = The agent sends long instructions: pick a large model and set Ollama's context length to 64k or more (Ollama app › Settings), or it loses track.
agent-engine-ollama-url = Address (as seen from the container)
agent-engine-model = Model
agent-engine-url = Address
agent-engine-api-placeholder-claude = https://api.example.com (without /v1)
agent-engine-api-format-claude = The API must accept the Claude API format (/v1/messages).
agent-engine-api-format-codex = The API must accept OpenAI's Responses format (/responses).
agent-engine-key = Key
agent-engine-key-saved = key saved
agent-engine-key-delete = Delete the key
agent-engine-key-save = Save the key
agent-engine-api-note = { $format } The key stays in your Mac's Keychain: { $agent } never sees it.
agent-engine-url-invalid = Invalid address
agent-engine-url-invalid-https = Invalid address (https://…)
agent-engine-model-invalid = Invalid model
agent-engine-custom-too-long = Address too long
agent-engine-custom-https = The address must start with https://
agent-engine-custom-missing-s = %s is missing where the search words go

## Ollama model picker

agent-ollama-none = No model installed in Ollama.
agent-ollama-choose = Choose a model
agent-ollama-missing = { $name } (not installed)
agent-ollama-refresh = Refresh
agent-ollama-silent = Ollama does not answer at this address.

## Settings › Data

agent-data-folder = Folder
agent-data-reveal = Show in Finder
agent-data-notes = Research notebook
agent-data-notes-help = The lessons the agent draws from searches where it got lost, dated by Ressac with the sites they come from. It rereads the latest ones at the start of each search: delete any line that reads like an instruction.
agent-data-import-title = Import
agent-data-import = Import from another browser
agent-data-backups = Backups
agent-data-delete = Delete
agent-data-delete-label = Delete the backup
agent-data-delete-confirm = Permanently delete this backup?
agent-data-none = No backups.
agent-data-export = Export
agent-data-exported = Exported to { $path }
agent-data-reset = Reset
agent-data-reset-confirm = Reset Ressac? Its data (spaces, tabs, history, settings, widget and action data) is set aside in a backup, then Ressac restarts from scratch. These stay in place: the workspace folder (your projects and what the agent created), the local AI models, the Claude and Codex sign-ins (Sign out buttons, Agent section), Codex's compatible API key (macOS Keychain), the browser's cookies and passwords (the browser's advanced settings).
agent-data-reset-go = Reset and restart
agent-data-reset-cancelled = Restart cancelled: nothing was reset.
agent-cancel = Cancel
agent-size-gb = { $n } GB
agent-size-mb = { $n } MB

## Settings › Privacy

agent-grants-revoke = Remove
agent-grants-confirm = The data read with this account is erased.
agent-grants-none = No access granted.
agent-grants-ephemeral = Temporary tab access is not listed.
agent-grants-external = External design mode projects
agent-grants-allowed = allowed
agent-grants-denied = denied
agent-grants-site-permission = { $label }: { $decision }
agent-permission-notifications = Notifications
agent-permission-geolocation = Location
agent-permission-media-camera = Camera
agent-permission-media-micro = Microphone
agent-permission-midi = MIDI
agent-permission-drm = Protected content
agent-screen-title = Screen sharing
agent-screen-broken = Screen sharing no longer works
agent-screen-help = After an update, macOS can block sharing even though it looks allowed. Repairing makes it ask for permission again.
agent-screen-repaired = Quit and reopen Ressac. At the next share, macOS will ask for permission again.
agent-screen-failed = The repair failed. In System Settings › Privacy & Security › Screen Recording, remove Ressac then relaunch it.
agent-screen-done = Repaired
agent-screen-repair = Repair

## Settings › Shortcuts

agent-shortcuts-vim = Vim mode
agent-shortcuts-vim-help = Vim-style keys to move around web pages.
agent-shortcuts-prompt = Press the new combination…
agent-shortcuts-reset = Restore
agent-shortcuts-edit = Change
agent-shortcuts-reset-all = Restore all
agent-shortcuts-fixed-tab = Tab 1 to 9
agent-shortcuts-fixed-space = Space 1 to 9
agent-shortcuts-fixed-recent = Recent tabs

## Settings › Agent › Mozilla account

agent-mozilla-title = Mozilla account (agent extensions)
agent-mozilla-help = Firefox only installs extensions signed by Mozilla. Ressac has them signed with your Mozilla developer account (free).
agent-mozilla-on = Account connected
agent-mozilla-off = Not connected
agent-mozilla-remove = Remove
agent-mozilla-link = Open the Mozilla keys page
agent-mozilla-steps = Sign in or create an account, accept the developer agreement, then generate credentials.
agent-mozilla-issuer = JWT issuer
agent-mozilla-secret = JWT secret
agent-mozilla-save = Save

## Settings › Privacy

agent-telemetry-notice = Ressac sends its developer crashes and errors, without any page address, to fix the beta's bugs, and an anonymous install identifier at each launch to count users. A crash can contain fragments of memory.

## Agent panel

agent-panel-handle = Agent panel width
agent-panel-label = Agent
agent-panel-signed-out = { $name } (signed out)
agent-panel-codex-signed-out = Codex is not signed in to your ChatGPT account.
agent-panel-login = Sign in
agent-panel-preparing = Preparing the agent… (the first time, building the container takes a few minutes)
agent-panel-machine-starting = The workshop is starting…
agent-panel-build-step =
    Preparing the agent, step { $step }/{ $of }: { $label }… ({ $minutes ->
        [0] under 1
       *[other] { $minutes }
    } min) (the first time, building the container takes a few minutes)
agent-panel-docker-absent = Docker is not running. Browsing works; only the agent is unavailable.
agent-panel-error = The agent could not start: { $message }
agent-panel-done = The agent has stopped.
agent-panel-asleep = Put to sleep to free memory — resumes at your next message
agent-panel-retry = Try again
agent-panel-restart = Restart
agent-panel-engine-changed = The agent's engine or mode changed. Restart to use it: the conversation resumes.
agent-panel-mode = Agent mode
agent-panel-mode-browser = Browser
agent-panel-mode-browser-title = Search and recaps, no terminal
agent-panel-mode-workshop = Workshop
agent-panel-mode-workshop-title = Can run commands: install and launch project apps
agent-review-title = The agent's instructions changed
agent-review-intro = Since the last session, these files were modified, perhaps by a page the agent read.
agent-review-created = new
agent-review-deleted = deleted
agent-review-too-long = File too long to show
agent-review-too-many = Too many files to show
agent-review-unreadable = Unreadable file
agent-review-binary = Binary file, not shown
agent-review-other = Special file, not shown
agent-review-link = Link to { $target }
agent-review-folded = ⋯ { $count ->
        [one] { $count } line
       *[other] { $count } lines
    }
agent-review-keep = Keep the changes
agent-review-revert = Go back to the previous version

## Review

agent-review-label = Review
agent-review-send = Send { $count ->
    [one] { $count } comment
   *[other] { $count } comments
} to { $destination }
agent-review-nobody = nobody
agent-review-mark-read = Mark as reviewed
agent-review-refresh = Refresh
agent-review-unavailable = Review unavailable: { $reason }
agent-review-open-failed = the review could not be opened
agent-review-files = Changed files
agent-review-empty = Nothing has changed since the last review.
agent-review-comments = Comments
agent-review-gone = This file is no longer in this comparison: refresh the review.
agent-review-status-added = added
agent-review-status-deleted = deleted
agent-review-status-modified = modified

## Compared file and comments

agent-diff-label = Diff of { $path }
agent-diff-binary = binary file
agent-diff-too-big = file too big for the review
agent-diff-no-lines = No changed lines.
agent-diff-expand = Show hidden lines
agent-diff-range-outside = A comment covers lines of a single block of the diff.
agent-diff-comment-line = Comment on line { $line }
agent-diff-comment-title = Comment (Shift+click or drag: several lines)
agent-diff-comment-placeholder = Comment (plain text, Markdown shown as is)
agent-diff-comment-submit = Comment
agent-diff-comment-failed = The comment could not be saved.
agent-comment-line = Line { $line }
agent-comment-lines = Lines { $start }–{ $end }
agent-comment-sent = sent
agent-comment-resolved = resolved
agent-comment-line-changed = the line has changed
agent-comment-text = Comment text
agent-comment-save = Save
agent-comment-edit = Edit
agent-comment-reopen = Reopen
agent-comment-resolve = Resolve
agent-comment-delete = Delete

## Design mode: basket and bubble

agent-basket-label = Design mode basket
agent-basket-title = Basket
agent-basket-close = Close the basket
agent-basket-empty = No remarks. Click an element on the page to write one.
agent-basket-delete = Delete
agent-basket-sent-label = Sent batches
agent-basket-sent = Sent
agent-basket-state-pending = pending
agent-basket-state-read = read
agent-basket-state-handled = handled
agent-basket-destination-agent = agent
agent-basket-handled = Handled
agent-basket-send = Send { $count ->
    [one] { $count } remark
   *[other] { $count } remarks
} to { $destination }
agent-bubble-label = Remark on the element
agent-bubble-placeholder = Your remark on this element
agent-bubble-add = Add to the basket

## Settings › Shortcuts: vim keys (ids by position in shared/vim-keys.ts, kept in step by test/agent-vim-i18n.test.ts)

agent-vim-0-title = Scroll
agent-vim-0-0 = One line down / up
agent-vim-0-1 = Left / right
agent-vim-0-2 = Half a page down / up
agent-vim-0-3 = Top / bottom of the page
agent-vim-1-title = Navigate
agent-vim-1-0 = Previous / next page
agent-vim-1-1 = Reload
agent-vim-1-2 = Address bar
agent-vim-1-3 = Copy the page address
agent-vim-2-title = Tabs and spaces
agent-vim-2-0 = Previous / next tab, wrapping around
agent-vim-2-1 = Previous / next tab, wrapping around
agent-vim-2-2 = First / last tab of the space
agent-vim-2-3 = New tab (command bar)
agent-vim-2-4 = Close the tab
agent-vim-2-5 = Reopen the closed tab
agent-vim-2-7 = Letters on the sidebar's tabs: type them to go there
agent-vim-2-6 = Next / previous space, wrapping around
agent-vim-3-title = Links and search
agent-vim-3-0 = Letters on the visible links: type them to open the link
agent-vim-3-1 = Same, in a new tab
agent-vim-3-2 = Search the page
agent-vim-4-title = Pause
agent-vim-4-0 = Pause the vim keys in this tab: everything goes to the page
agent-vim-4-1 = Resume (or pause)
agent-vim-4-2 = Leave the letters or a pending prefix
agent-vim-4-3 = Show this help
agent-vim-key-escape = Esc
