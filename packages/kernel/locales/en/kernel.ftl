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
kernel-err-internal-harvest = Update impossible: internal browser error
kernel-err-no-workflow = This widget has neither workflow.json nor harvest.mjs
kernel-err-interrupted = Interrupted: Ressac stopped
kernel-err-grant-required = Grant required to read with your account: { $domains }
kernel-err-reads-required = Grant required to read: { $domains }
kernel-err-reads-required-web = Grant required to read: { $domains } and the web
kernel-err-reads-required-web-only = Grant required to search and read the web
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
kernel-err-custom-profile-browser = The « { $name } » profile only runs in Workshop mode: choose Workshop in the agent panel.
kernel-replay-not-found = Replay impossible: run not found
kernel-replay-block-absent = Replay impossible: block « { $id } » is not in the workflow
kernel-replay-output-missing = Replay impossible: the output of « { $id } » is missing from this run
kernel-replay-output-truncated = Replay impossible: the output of « { $id } » was truncated in this run
kernel-replay-too-big = Replay impossible: the outputs to resume exceed 4 MB
kernel-network-failed = The agent's network could not be secured: { $error }
kernel-network-open = direct access is not closed (probe code { $code })

kernel-writer-none = Connect Claude Code or Codex in Settings › Agents for summaries
kernel-writer-limit = Your subscription limit is reached: summaries will resume later
kernel-writer-images = Images are not supported by writing
kernel-writer-failed-badge = AI writing failed: see the widget log
kernel-writer-failed = The AI could not write: { $reason }
