# Settings (agents, data, permissions, shortcuts, Mozilla account), agent panel, review, design mode.

## An agent's engine (Settings › Agent)

agent-engine-label = Engine
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
# A model run on ollama.com, not on this Mac: shown after its name in the picker.
agent-ollama-cloud = cloud (off this Mac)
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
agent-data-reset-confirm = Reset Ressac? Its data (spaces, tabs, history, settings, widget and action data) is set aside in a backup, then Ressac restarts from scratch. These stay in place: the workspace folder (your projects and what the agent created), the local AI models, the Claude and Codex sign-ins (Sign out buttons, Agent section), Codex's compatible API key (macOS Keychain), the browser's cookies and passwords (the browser's advanced settings), your passports (to delete in Settings › Passport).
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
agent-screen-broken = Screen sharing stopped working?
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


## Settings › Privacy

agent-telemetry-notice = Ressac sends its developer its errors, without any page address, to fix the beta's bugs, and an anonymous install identifier at each launch to count users. Firefox's crash reports, which can contain parts of the open pages, are only sent if you turn them on in Settings › Privacy.

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
agent-panel-mode-workshop-lab = Workshop (lab)
agent-panel-mode-workshop-lab-title = Needs the lab: Settings › Agent
agent-review-title = Some of the agent's settings changed
agent-review-intro = These files tell the agent how to behave. A page it read may have tried to change them: check that this change really comes from you.
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
agent-review-keep = It was me, keep
agent-review-revert = Undo these changes
agent-review-keep-hint = Only if you changed them yourself.
agent-review-revert-hint = Puts the files back as they were. Safe.
agent-review-detail-show = See the details
agent-review-detail-hide = Hide the details
agent-review-files-count = { $count ->
        [one] { $count } file
       *[other] { $count } files
    }
agent-review-name-instructions = Agent instructions
agent-review-name-override = Agent priority instructions
agent-review-name-guide = Agent guide
agent-review-name-codex-instructions = Codex instructions
agent-review-name-codex-config = Codex settings
agent-review-name-skill = Skill “{ $name }”
agent-review-name-skills = Skills folder
agent-review-name-other = Other agent file

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

# Masking banners in the agent panel.
agent-mask-locked = The agent has seen { $names }. You can carry on: Ressac will ask you before anything goes to another site.
agent-mask-locked-unnamed = The agent has seen a masked value. You can carry on: Ressac will ask you before anything goes to another site.
agent-mask-uncovered = Conversation not covered: started before masking, it may have seen your data in clear.
agent-mask-uncovered-passport = This conversation may have read in clear a value you have since added to your passport: the agent may know it. Everything else is still masked.
# The item's name in the « not covered » banner's tooltip (the fill cards' names).
agent-mask-passport-field-nom = your name
agent-mask-passport-field-naissance = your date of birth
agent-mask-passport-field-proche = a relative's name
agent-mask-passport-field-adresse = your address
agent-mask-passport-field-tel = your phone number
agent-mask-passport-field-email = your e-mail
agent-mask-passport-field-iban = your IBAN
agent-mask-passport-field-piece = your ID document number
agent-mask-passport-field-secu = your social security number
agent-mask-passport-field-plaque = your licence plate
agent-mask-passport-field-libre = an item of your passport
agent-mask-passport-unknown = a value of your passport
agent-mask-passport-unreadable = Your passport “{ $profile }” could not be read: its data is not masked from the agent.
agent-mask-passport-open = Open the passport
agent-mask-passport-no-space = No space
agent-mask-typed-reminder = What you type here, the agent sees
agent-mask-paste-names = This paste contains { $names }.
agent-mask-paste-unchecked = Ressac could not check this paste: nothing is sent until you choose.
agent-mask-paste-masked = Paste masked
agent-mask-paste-clear = Paste in clear
agent-mask-paste-cancel = Cancel
agent-mask-bubble-hide = Hide
agent-mask-bubble-unknown = This label does not belong to this conversation.
agent-lift-open = Lift the protection
agent-lift-title = Lift the protection
agent-lift-body = The workshop may hold { $names } in a form Ressac does not recognise. These files changed since the reveal:
agent-lift-unnamed = a revealed value
agent-lift-quarantine = Quarantine and unlock
agent-lift-keep = Keep the files and unlock
agent-lift-delete = Delete the files and unlock
agent-lift-checking = Looking for changed files…
agent-lift-none = No file changed.
agent-lift-keep-help = Tick the files to delete, then press « Keep the files and unlock » again: the others stay in the workshop.
agent-lift-remove = Delete
agent-lift-see = Show
agent-lift-hide = Hide

## The chat (the agent view « Discussion »)

chat-untitled = New conversation
chat-picker = Conversations
chat-new = New conversation
chat-advanced = Advanced mode (terminal)
chat-back = Back to the chat
chat-menu = Mode and agent
chat-menu-note = A change opens a new conversation.
chat-model = Model
chat-model-default = Default
chat-model-loading = Reading the models…
chat-model-note = Applies from your next message, in this discussion and new ones.
chat-list-title = Conversations
chat-list-new = New
chat-list-close = Close the list
chat-list-live = Running (3 at most at once)
chat-list-paused = Paused, resumed when opened
chat-list-footer = Each conversation has its own context: it does not see the others.
chat-list-empty = No conversation yet.
chat-list-waiting = Waiting for your answer
chat-list-running = Working
chat-list-starting = Starting
chat-list-done = Done { $ago }
chat-list-queued = Waiting for a free conversation
chat-list-error = Stopped on an error
chat-list-signed-out = Sign-in needed
chat-list-now = just now
chat-list-messages = { $count ->
        [one] { $count } message
       *[other] { $count } messages
    }
chat-delete = Delete the conversation “{ $title }”
chat-delete-title = Delete this conversation?
chat-delete-text = It will be erased from Ressac.
chat-delete-history = Also delete the history in { $engine }
chat-delete-confirm = Delete
chat-delete-cancel = Cancel
chat-delete-pending = The agent's history will be erased the next time a conversation starts.
chat-delete-history-failed = The agent's history could not be erased: Ressac will try again the next time a conversation starts.
chat-delete-failed = The conversation could not be deleted: { $message }
chat-composer-label = Message to the agent
chat-composer-placeholder = Ask the agent something (/ for commands, @ to point)
chat-composer-footer = Passport masked before sending
chat-composer-sent-to = Sent to { $host }
chat-composer-own-warning = Your model can make mistakes
chat-engine-own = Your model
chat-engine-own-remote = online
chat-engine-own-remote-title = This model is not on your Mac: your messages and what the agent reads go to { $host }.
chat-send = Send
chat-stop = Stop
chat-prefix = Attached to your next message
chat-prefix-drop = Remove
chat-chip-clear = Send in clear
chat-chip-mask = Keep masked
chat-chip-in-clear = in clear
# The composer's « / » commands and « @ » references (the names are what the user types after « / » or « @ »).
chat-commands = Commands
chat-refs = Point to
chat-command-model = model
chat-command-model-hint = Pick this conversation's model
chat-command-new = new
chat-command-new-hint = New conversation
chat-command-mode = mode
chat-command-mode-hint = Navigateur or Atelier, in a new conversation
chat-command-agent = agent
chat-command-agent-hint = Switch agent, in a new conversation
chat-command-terminal = terminal
chat-command-terminal-hint = Advanced mode: go on in the terminal
chat-command-search = search
chat-command-search-hint = Search the web: type your search after it
chat-command-read = read
chat-command-read-hint = Summarize the page on screen
chat-command-tabs = tabs
chat-command-tabs-hint = List your open tabs
chat-command-history = history
chat-command-history-hint = Search your history: type the words after it
chat-command-bookmarks = bookmarks
chat-command-bookmarks-hint = Search your bookmarks: type the words after it
chat-ref-tab = tab
chat-ref-tab-hint = An open tab: the agent may read it in this conversation
chat-ref-page = page
chat-ref-page-hint = The page on screen
chat-ref-history = history
chat-ref-history-hint = A page from your history
chat-ref-bookmark = bookmark
chat-ref-bookmark-hint = One of your bookmarks
chat-ref-tab-title = The agent may read this tab in this conversation without asking you. Click to remove it.
chat-ref-page-title = The agent gets this page's title and address. Click to remove it.
chat-user-pages = Pages sent with the message
chat-unsent = not sent
chat-copy = Copy
chat-copy-code = Copy the code
chat-new-messages = New messages
chat-tool-running = running
chat-tool-done = done
chat-tool-failed = failed
chat-tool-show-tab = Show the tab
chat-working = The agent is working
chat-working-thinking = Thinking…
chat-working-writing = Writing…
chat-working-acting = Working…
chat-question = The agent's question
chat-question-validate = Confirm
chat-question-ignored = Question skipped
chat-queued = Waiting for a free conversation: three are already working.
chat-paused = Conversation paused: it resumes at your next message.
chat-waiting = { $count ->
        [one] A message waits for the agent to start.
       *[other] { $count } messages wait for the agent to start.
    }
chat-error = The conversation stopped: { $message }
chat-open-failed = The conversation could not open: { $message }
chat-reveal = See the value, here only
chat-masked-nom = masked name
chat-masked-adresse = masked address
chat-masked-carte = masked card
chat-masked-iban = masked IBAN
chat-masked-tel = masked phone
chat-masked-email = masked email
chat-masked-code = masked code
chat-masked-id = masked ID number
chat-masked-cle = masked key
chat-masked-secu = masked social security number
chat-masked-motdepasse = masked password
chat-masked-date = masked date
chat-masked-masque = masked value
chat-login-title = Connect your { $name } account
chat-login-intro = Only once. The sign-in happens in { $cli } itself: Ressac never sees your password. Then everything happens here, in the chat.
chat-login-step-1 = Click “Sign in”.
chat-login-step-2 = Your browser opens { $name }'s page: accept.
chat-login-step-3 = If you are given a code, paste it below.
chat-login-button = Sign in
chat-login-running = { $cli }, signing in
chat-login-terminal = Sign-in terminal
chat-login-alt = No subscription?
chat-login-api-key = Use an API key
chat-login-or = or
chat-login-local = a local model
chat-switch-failed = Switching between the terminal and the chat failed: { $message }
