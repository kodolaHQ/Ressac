# Texts the kernel shows the user: watch notifications, workshop build steps, applications, local AI install.

kernel-new-items = { $n ->
    [one] { $n } new item
   *[other] { $n } new items
}

kernel-build-base-image = Downloading the base image
kernel-build-system-tools = System tools
kernel-build-claude-codex = Installing Claude Code and Codex
kernel-build-preparing = Preparing
kernel-container-start-failed = Container { $name } could not start: { $error }

kernel-app-docker-not-running = Docker is not running.
kernel-app-no-port = No free port left: stop an application.
kernel-app-not-responding = The application does not answer on port { $port } after { $seconds } s.
kernel-app-exit-code = Stopped with code { $code }
kernel-app-exit-unknown = Stopped with an unknown code

kernel-ai-install-cancelled = Installation cancelled
kernel-ai-install-running = Installation already in progress
kernel-ai-download-failed = The model download failed: { $error }
kernel-ai-hash-mismatch = The downloaded model is corrupt: it was deleted, start the download again.
kernel-ai-llama-server-missing = llama-server not found
kernel-ai-not-installed = Local AI not installed
kernel-ai-llama-unreachable = llama-server is not responding: { $error }
kernel-ai-llama-status = llama-server answered { $status }
kernel-ai-llama-start-failed = llama-server did not start: { $detail }
kernel-ai-llama-start-timeout = llama-server did not start: timed out. { $detail }

# Errors the kernel writes into widget and action runs (shown on the cards). Stored texts stay in their language.
kernel-err-timeout = Timed out
kernel-err-response-too-big = Response too large
kernel-err-profile-denied = The chosen sign-in profile can no longer be used (deleted or used by a private space): the grant must be given again
kernel-err-workshop-stopped = Update impossible: workshop stopped
kernel-widget-lab-required = This widget has code written by the agent or follows the web (watch): it needs the lab.
kernel-err-internal-harvest = Update impossible: internal browser error
kernel-err-no-workflow = This widget has neither workflow.json nor harvest.mjs
kernel-err-interrupted = Interrupted: Ressac stopped
kernel-err-grant-required = Grant required to read with your account: { $domains }
kernel-err-reads-required = Grant required to read: { $domains }
kernel-err-reads-required-web = Grant required to read: { $domains } and the web
kernel-err-reads-required-web-only = Grant required to search and read the web
kernel-err-code-changed = The code changed since your approval
kernel-err-no-result = The harvest ended without a result (code { $code })
kernel-err-no-result-no-code = The harvest ended without a result
kernel-err-action-stopped = Stopped at your request
kernel-err-action-internal = Action impossible: internal browser error
kernel-err-action-no-workflow = This action has no workflow.json
kernel-err-result-too-big = Results too large to keep
kernel-err-cannot-launch = Harvest could not start: { $error }
kernel-harvest-folder-refused = The widget's or action's folder is a link, or is gone
kernel-harvest-file-too-big = { $name } is too big to run (1 MB per file, 4 MB in all)
kernel-err-data-too-big = Data too large (2 MB at most)
kernel-memory-not-kept = Block memory not kept: over 3 MB (the old one stays)
kernel-log-lines-cut = … { $n } lines cut

# Errors of the grant card (shown under it).
kernel-grant-action-unknown = Unknown action: { $id }
kernel-grant-action-unreadable = Unreadable action: { $error }
kernel-grant-action-no-account = Action { $id } does not read with an account
kernel-grant-action-changed = The declaration of action { $id } changed since the request was shown: nothing is granted, read the new request.
kernel-grant-widget-unknown = Unknown widget: { $id }
kernel-grant-widget-unreadable = Unreadable widget: { $error }
kernel-grant-widget-no-account = Widget { $id } does not read with an account
kernel-grant-widget-changed = The declaration of widget { $id } changed since the request was shown: nothing is granted, read the new request.
kernel-widget-invalid = widget.json invalid: { $error }

# Texts of the command runner (shown in install and workshop errors).
kernel-run-not-found = { $command } not found
kernel-run-cancelled = Cancelled

# Errors shown in the interface (unknown action, input, replay, workshop).
kernel-err-action-unknown = Unknown action
kernel-err-input-required = Input required: { $label }
kernel-err-workshop-unavailable = Container unavailable ({ $state })
kernel-err-machine-stopped = The workshop machine is not running: try again, or see why in Settings › Workshop.
kernel-err-lab-off = This feature is part of the lab, which is off: Settings › Agent › Usage level.
kernel-mcp-lab-off = This tool is part of the lab, which the user turned off: do not insist, tell them what they would need to turn on.
kernel-workshop-no-engine = The workshop has no engine: neither its machine nor Docker is available.
kernel-workshop-path-unmountable = This path cannot be mounted in the workshop: { $path }
kernel-err-custom-profile-browser = The « { $name } » profile only runs in Workshop mode: choose Workshop in the agent panel.
kernel-err-instructions-changed = The agent's instructions changed since the last session: reopen the panel to review them.
kernel-err-instructions-io = Could not read or restore the agent's instructions: { $error }
kernel-replay-not-found = Replay impossible: run not found
kernel-replay-block-absent = Replay impossible: block « { $id } » is not in the workflow
kernel-replay-output-missing = Replay impossible: the output of « { $id } » is missing from this run
kernel-replay-output-truncated = Replay impossible: the output of « { $id } » was truncated in this run
kernel-replay-too-big = Replay impossible: the outputs to resume exceed 4 MB
kernel-network-failed = The agent's network could not be secured: { $error }
kernel-network-open = direct access is not closed (probe code { $code })

kernel-writer-none = Connect Claude Code or Codex in Settings › Agent for summaries
kernel-writer-workshop-stopped = The agent's workshop is not started: summaries will resume once it starts
kernel-writer-limit = Your subscription limit is reached: summaries will resume later
kernel-writer-images = Images are not supported by writing
kernel-writer-failed-badge = AI writing failed: see the widget log
kernel-writer-failed = The AI could not write: { $reason }
kernel-writer-key-refused = key refused

# Masking: how a card names a masked value without showing it (your sources, then the rest of the web).
kernel-mask-name-code = your code
    .de = of your code
kernel-mask-name-iban = your IBAN
    .de = of your IBAN
kernel-mask-name-carte = your card
    .de = of your card
kernel-mask-name-tel = your phone number
    .de = of your phone number
kernel-mask-name-email = your e-mail
    .de = of your e-mail
kernel-mask-name-adresse = your address
    .de = of your address
kernel-mask-name-nom = your name
    .de = of your name
kernel-mask-name-id = your identifier
    .de = of your identifier
kernel-mask-name-secu = your social security number
    .de = of your social security number
kernel-mask-name-motdepasse = your password
    .de = of your password
kernel-mask-name-masque = your masked value
    .de = of your masked value
kernel-mask-name-date = your date
    .de = of your date
kernel-mask-name-web-code = a code
    .de = of a code
kernel-mask-name-web-iban = an IBAN
    .de = of an IBAN
kernel-mask-name-web-carte = a card number
    .de = of a card number
kernel-mask-name-web-tel = a phone number
    .de = of a phone number
kernel-mask-name-web-email = an e-mail
    .de = of an e-mail
kernel-mask-name-web-adresse = an address
    .de = of an address
kernel-mask-name-web-nom = a name
    .de = of a name
kernel-mask-name-web-id = an identifier
    .de = of an identifier
kernel-mask-name-web-secu = a social security number
    .de = of a social security number
kernel-mask-name-web-motdepasse = a password
    .de = of a password
kernel-mask-name-web-masque = a masked value
    .de = of a masked value
kernel-mask-name-web-date = a date
    .de = of a date

# Masking: revealing a value and the conversation's lock.
kernel-mask-reveal-card = The agent wants to see { $name } for this task. Then the conversation and the workshop stay locked until you lift the lock.
kernel-mask-reveal-shared = Another conversation is using the workshop: the agent cannot see { $name } while it runs.
kernel-mask-locked-danger = Conversation locked: { $name } { $agreement ->
        [other-m] were
        [other-f] were
       *[one-m] was
    } revealed. This outflow needs your approval.
kernel-mask-locked-refused = Conversation locked: this outflow did not get your approval.
kernel-mask-handle-danger = This address holds { $name }, read on { $from }: it sends { $agreement ->
        [other-m] them
        [other-f] them
       *[one-m] it
    } to { $to }.
kernel-mask-label-alert = The agent sends the { $agreement ->
        [other-m] labels { $de } (not the values)
        [other-f] labels { $de } (not the values)
       *[one-m] label { $de } (not the value)
    } to { $destination }.
kernel-mask-destination-engine = your search engine
kernel-mask-destination-page = the page of tab { $id }
kernel-mask-unknown-label = Label from an earlier conversation or unknown: read the page again.
kernel-mask-fill-blocked = Filling blocked for this conversation: too many unknown labels. A new conversation unblocks it.
kernel-mask-no-login = No saved login for this site: nothing was filled.
kernel-mask-fill-changed = The field changed before filling: nothing was written. Ask again.
kernel-mask-fill-action-danger = This form sends to { $to }, not to the field's site.
kernel-mask-fill-foreign-danger = This page, opened by the agent, is on { $to }: { $name } { $agreement ->
       *[one-m] was
    } read on { $from }.
kernel-mask-fill-foreign-passport = This page, opened by the agent, is on { $to }, not on one of the sites your passport sets for { $name } ({ $from }).
kernel-mask-fill-foreign-danger-user = This page is on { $to }, and { $name } { $agreement ->
       *[one-m] was
    } read on { $from }: check it is the site you expect.
kernel-mask-fill-foreign-passport-user = This page is on { $to }, not on one of the sites your passport sets for { $name } ({ $from }).
kernel-mask-fill-framed = This field is in a frame from { $frame }, inside the page of { $top }.
kernel-mask-fill-check = tick
kernel-mask-fill-uncheck = untick
kernel-mask-fill-option = choose « { $option } »
kernel-mask-fill-choice-acts = On your tab, ticking or choosing can act at once: a setting saved, or even the form sent.
kernel-mask-fill-choice-acts-agent = On this agent tab, an account you signed into may still be open: ticking or choosing can act at once, a setting saved, or even the form sent.
kernel-mask-name-fill-text = a text from the agent
kernel-mask-fill-login-pair = your username and your password
kernel-mask-capture-refused = Capture refused: this tab shows your data.
kernel-mask-devtools-card = The developer tools would see your data in clear.
kernel-mask-store-locked = The workshop is locked since a reveal: nothing is written to what outlives the conversation until you lift the lock.
kernel-mask-apps-locked = The workshop is locked since a reveal: no app starts until you lift the lock.
kernel-mask-reveal-cut-failed = The workshop could not be locked: the agent cannot see { $name }.
kernel-mask-run-paused = Paused: its code changed since a reveal, it resumes when you lift the workshop's lock.
kernel-err-code-refused = Launch refused when its code was checked: nothing ran.
kernel-mask-design-locked = Ressac's workshop is locked since a reveal: the external MCP answers again once the user lifts the lock.
kernel-mask-lift-session = Stop the conversation to lift the lock
kernel-mask-lift-move-failed = The lock stays: { $path } could not be moved ({ $error }).
kernel-mask-lift-workshop = The lock stays: the workshop does not answer ({ $state }).
kernel-mask-lift-busy = The lock is already being lifted.
kernel-mask-restore-busy = Stop the conversation and the agent's apps to give this file back.
# Masking: « of » before a name that is not a known value.
kernel-mask-de = of { $name }

# Passport: how a card names a passport value, by field then by kind (design § 9.5).
kernel-mask-passport-name-nom = your name
kernel-mask-passport-name-naissance = your date of birth
kernel-mask-passport-name-proche = a relative's name
kernel-mask-passport-name-adresse = your address
kernel-mask-passport-name-tel = your phone number
kernel-mask-passport-name-email = your e-mail
kernel-mask-passport-name-iban = your IBAN
kernel-mask-passport-name-piece = your ID document number
kernel-mask-passport-name-secu = your social security number
kernel-mask-passport-name-plaque = your licence plate
kernel-mask-passport-name-libre = an item of your passport
kernel-mask-passport-name-prenoms = your first name
kernel-mask-passport-name-nom_famille = your family name
kernel-mask-passport-name-nom_complet = your name
kernel-mask-passport-name-adresse_voie = your street
kernel-mask-passport-name-code_postal = your postcode
kernel-mask-passport-name-ville = your city
