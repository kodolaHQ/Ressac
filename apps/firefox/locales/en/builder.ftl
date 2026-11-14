# Workflow builder, action and recap pages, the Actions list.

## Run labels

builder-trigger-scheduled = Scheduled
builder-trigger-manual = Manual
builder-trigger-agent = By the agent
builder-trigger-replay = Trial
builder-status-succeeded = Succeeded
builder-status-partial = Partial
builder-status-failed = Failed
builder-status-interrupted = Interrupted
builder-status-grant-required = Permission needed
builder-status-lower-succeeded = succeeded
builder-status-lower-partial = partial
builder-status-lower-failed = failed
builder-status-lower-interrupted = interrupted
builder-status-lower-grant-required = permission needed
builder-block-succeeded = succeeded
builder-block-partial = partial
builder-block-failed = failed
builder-block-interrupted = interrupted
builder-block-not-run = not run
builder-block-resumed = resumed
builder-duration-running = running
builder-elements = { $count ->
    [one] { $count } item
   *[other] { $count } items
}
builder-attempt-since = Trial from "{ $start }"
builder-attempt-since-lower = trial from "{ $start }"
builder-attempt-tag = trial
builder-no-run = No runs yet.
builder-loading = Loading…

## Builder

builder-save-saved = Saved
builder-save-saving = Saving…
builder-save-invalid = Not saved: { $reason }
builder-save-error = Save error: { $reason }
builder-awaiting-choice = the agent changed the workflow, pick a version
builder-save-impossible = Could not save
builder-no-free-code-file = no free file name for the Code block
builder-workflow-unreadable = workflow.json is unreadable
builder-grant-error = Permission not saved: { $reason }
builder-tab-workflow = Workflow
builder-tab-runs = Runs
builder-preview-action = Page preview
builder-preview-widget = Widget preview
builder-rearrange = Tidy up
builder-running = Running…
builder-launch = ▶ Run
builder-banner-proposal = The agent changed the workflow while yours was not saved.
builder-banner-take = Take its version
builder-banner-keep = Keep mine
builder-banner-unreadable = workflow.json is unreadable on disk (the agent may be writing it).
builder-pane-agent = Agent
builder-pane-block = Block
builder-no-workflow-action = This action has no workflow (workflow.json), or action.json is unreadable.
builder-no-workflow-widget = This widget has no workflow (neither workflow.json nor harvest.mjs).
builder-launch-dialog = Run the action
builder-cancel = Cancel
builder-canvas = Workflow canvas
builder-palette = Blocks
builder-palette-no-web-action = The action must declare "web": true in its sources (action.json): ask the agent.
builder-palette-no-web-widget = The widget must declare "web": true: ask the agent.
builder-node-error = Error
builder-node-warning = Warning

## Runs bar

builder-replay = Replay from this block
builder-replay-select = Select a block
builder-replay-failed = Replay failed: { $reason }
builder-unexpected-error = unexpected error

## A block's tab

builder-block-unknown = Unknown block type: its settings cannot be edited here.
builder-field-name = Name
builder-field-id = Identifier
builder-field-choose = — choose —
builder-field-default = Default
builder-field-default-value = Default ({ $value })
builder-field-template = template
builder-field-template-help = The { "{paths}" } are replaced by the values received
builder-field-one-per-line = One value per line
builder-field-available = Available fields: { $fields }
builder-output-title = At the chosen run
builder-output-missing = This run can no longer be read.
builder-output-not-in-run = This block was not in this run.
builder-output-status = Status
builder-output-duration = Duration
builder-output-items = Items
builder-output-resumed = Output taken from run { $run }
builder-output-trial = (trial)
builder-output-log = Log ({ $count })
builder-output-output = Output
builder-output-truncated = Output (truncated)

## A block's code

builder-code-title = Code
builder-code-unsaved = Code not saved
builder-code-save = Save the code
builder-code-changed = The file changed on disk
builder-code-reload = Reload
builder-code-keep = Keep mine
builder-code-confirm-switch = The code of { $name } is not saved. Switch block anyway? It stays kept in this window.
builder-code-confirm-close = The code of { $names } is not saved. Close anyway? It will be lost.

## Action and widget panels

builder-panel-account = Domains with an account
builder-panel-public = Public domains
builder-panel-none = none
builder-panel-none-f = none
builder-panel-input = Input asked at launch
builder-panel-layout = Page layout instruction
builder-panel-web-open = Web access: open
builder-panel-hours = Scheduled hours: { $hours }
builder-panel-max-duration = Maximum duration: { $minutes } min
builder-panel-notify = Notification when done: yes
builder-panel-config = Configuration
builder-panel-help-widget = To change the sources or the configuration, ask the agent.
builder-panel-help-action = To change the sources, the input or the page layout, ask the agent.
builder-panel-select = Select a block to see its settings.
builder-preview-trial = Preview of a trial: not the action's latest result
builder-preview-no-page = No page for this run.

## An action's page

action-unknown = Unknown action
action-no-result = No result
action-result-gone = This result no longer exists
action-fallback-mention = simple layout
action-private = Actions are not available in a private space
action-recap-private = Recaps are not available in a private space
action-launch-failed = The action could not be started
action-not-yet = No result yet
action-grant-required = Permission needed to read with your account: { $domains }
action-authorize = Allow…
action-show-latest = See the latest result
action-relaunch = Run again
action-launch = Run
action-show-workflow = See the workflow
action-previous = Previous results
action-stop = Stop
action-pending = Waiting: two actions are already running
action-layout = Laying out the page…
action-reading = Reading { $host }…
action-table-link = Link
action-others = { $count ->
    [one] … and { $count } other
   *[other] … and { $count } others
}

## Recap in a tab

recap-loading = Loading…
recap-gone = This recap was closed.
recap-meta = Agent recap · { $date }
recap-live = live
recap-live-kept = { $count ->
    [one] live · { $count } kept
   *[other] live · { $count } kept
}
recap-writing = Writing the recap…
recap-foot = This recap goes away when you close the tab.

## Actions list

actions-title = Actions
actions-last-never = Never run
actions-empty = No actions. Ask the agent to create one for you.
actions-input-required = Input required: { $label }
actions-launch = Run
actions-show-workflow = See the workflow
actions-remove-grant = Remove permission
actions-delete = Delete
actions-confirm-grant = Remove the permission of "{ $name }"? Its runs, results and memory will be erased.
actions-confirm-delete = Delete "{ $name }"? Its folder goes to the Trash; its results and permission will be erased.
actions-cancel = Cancel

builder-family-sources = Sources
builder-family-lists = Lists
builder-family-ai = AI
builder-family-logic-code = Logic/Code
builder-family-output = Output
