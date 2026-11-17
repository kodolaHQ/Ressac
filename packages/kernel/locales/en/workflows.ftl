# Workflow texts the user reads: builder (validation, warnings, blocks), logs.

workflows-invalid-prefix = Invalid workflow:

# Validation (after the prefix).
workflows-val-at = { $name }: { $message }
workflows-val-duplicate-id = duplicate block id: { $id }
workflows-val-unknown-type = unknown type: { $type }
workflows-val-per-item-no = { $id }.perItem: type { $type } does not work item by item
workflows-val-budget = { $id }.budgetSeconds: { $max } at most
workflows-val-keepdays-reuse = { $id }.keepDays: only with reuse
workflows-val-link-absent = link to a missing block: { $id }
workflows-val-no-output = no output
workflows-val-many-outputs = several outputs: { $ids }
workflows-val-cycle = cycle: { $cycle }
workflows-val-missing-input = { $id }: missing input (link a block before it)
workflows-val-output-page-denied = output: to "page" only in an action
workflows-val-output-page-required = output: an action returns a page (to: "page")
workflows-val-streaming-action = output.live: not in an action
workflows-val-web-required = web.search: the widget must declare "web": true

# Shape problem messages.
workflows-val-block-id = invalid block id (a-z, 0-9 and -, 40 characters at most)
workflows-val-mjs-file = a .mjs file from the widget's folder expected
workflows-val-key-path = invalid key path
workflows-val-unknown-to = unknown to: { $value }
workflows-val-type-string = text expected
workflows-val-type-number = number expected
workflows-val-type-int = integer expected
workflows-val-type-boolean = boolean expected
workflows-val-type-array = list expected
workflows-val-type-object = object expected
workflows-val-type-other = { $expected } expected
workflows-val-missing = missing ({ $expected })
workflows-val-max-items = { $n ->
    [one] { $text } item at most
   *[other] { $text } items at most
}
workflows-val-max-chars = { $n ->
    [one] { $text } character at most
   *[other] { $text } characters at most
}
workflows-val-less-than = must be less than { $n }
workflows-val-at-most = { $n } at most
workflows-val-min-items = { $n ->
    [one] at least { $text } item
   *[other] at least { $text } items
}
workflows-val-min-chars = { $n ->
    [one] at least { $text } character
   *[other] at least { $text } characters
}
workflows-val-empty = empty
workflows-val-greater-than = must be greater than { $n }
workflows-val-at-least = at least { $n }
workflows-val-one-value = { $values } expected
workflows-val-one-of = one of { $values } expected
workflows-val-unknown-key = unknown parameter

# Reading and saving.
workflows-file-leaves-folder = workflow.json leaves the widget's folder
workflows-file-too-big = workflow.json is over { $kb } KB
workflows-file-bad-json = workflow.json unreadable (not valid JSON)
workflows-file-unreadable = workflow.json unreadable
workflows-save-widget-not-found = Widget not found
workflows-save-code-absent = Not saved: file { $source } is missing
workflows-save-too-big = Workflow too big: { $kb } KB at most
workflows-code-invalid-name = Invalid file name
workflows-code-too-big = File too big: { $kb } KB at most
workflows-code-leaves-folder = The file leaves the widget's folder
workflows-code-unreadable = File unreadable
workflows-code-write-failed = Could not write

# Warnings.
workflows-warn-streaming = nothing to publish as it goes: the output's input is not processed item by item
workflows-warn-web-no-duration = without maxDurationMinutes, this widget may be cut off at 150 s: ask the agent to declare maxDurationMinutes
workflows-warn-input = { "{input}" }: the action does not declare an input (input)
workflows-warn-domain = undeclared domain: { $host }
workflows-warn-config = config.{ $key } is missing from the widget's configuration

# Run.

# Blocks: names and descriptions.
workflows-block-ai-sort = Sort with the local AI
workflows-block-ai-sort-desc = Scores each item with the local AI and keeps those that pass the threshold.
workflows-block-ai-write = Write with AI
workflows-block-ai-write-desc = Has the AI write a text from an instruction.
workflows-block-code = Code
workflows-block-code-desc = Runs one of the widget's .mjs files on the received input.
workflows-block-list-dedupe = Remove duplicates
workflows-block-list-dedupe-desc = Removes the items that have the same value for the given keys.
workflows-block-list-keep = Keep the first N
workflows-block-list-keep-desc = Keeps the first items of the list.
workflows-block-list-new = Keep the new ones
workflows-block-list-new-desc = Only keeps the items not yet seen in earlier runs.
workflows-block-output = Output to the widget
workflows-block-output-desc = Sends the result to the widget (or elsewhere).
workflows-block-source-feed = Read RSS feeds
workflows-block-source-feed-desc = Reads RSS or Atom feeds and returns their articles.
workflows-block-source-fetch = Fetch an address
workflows-block-source-fetch-desc = Fetches the content of an address, as text or JSON.
workflows-block-source-page = Read a page
workflows-block-source-page-desc = Reads the text of a web page.
workflows-block-web-search = Search the web
workflows-block-web-search-desc = Searches DuckDuckGo and returns the results (title, address, excerpt).

# Blocks: fields.
workflows-help-templates = The { "{paths}" } are replaced by the item's values.
workflows-help-no-value = Without a value: forever.
workflows-field-per-item = One item at a time
workflows-field-per-item-help = Applies the block to each item of the received list.
workflows-field-on-error = On error
workflows-field-budget = Maximum duration (seconds)
workflows-field-budget-help = 170 s at most, or the run's maximum duration
workflows-field-reuse = Reuse a previous result
workflows-field-reuse-help = Path of the key that identifies the item.
workflows-field-keep-days = Keep (days)
workflows-field-question = Question
workflows-field-question-help = What the local AI must judge, for example « Is it interesting? ».
workflows-field-judged-text = Text to judge
workflows-field-threshold = Threshold
workflows-field-score-field = Score field
workflows-field-prompt = Instruction
workflows-field-answer-field = Answer field
workflows-field-json = JSON answer
workflows-field-max-text = Maximum text size
workflows-field-file = File
workflows-field-file-help = A .mjs file from the widget's folder.
workflows-field-call = Call
workflows-field-keys = Keys
workflows-field-keys-help = Paths of the values that identify an item.
workflows-field-count = Number of items
workflows-field-key = Key
workflows-field-key-help = Path of the value that identifies an item.
workflows-field-forget-days = Forget after (days)
workflows-field-destination = Destination
workflows-field-live = Publish as it goes
workflows-field-live-help = Each finished item is shown without waiting for the end of the run.
workflows-field-feed-urls = Feed addresses
workflows-field-address = Address
workflows-field-format = Format
workflows-field-result-field = Result field
workflows-field-account = With my account
workflows-field-scroll = Screens to scroll
workflows-field-scroll-help = For a page that loads as you scroll. Empty or 0: no scrolling.
workflows-field-search-query = Search
workflows-field-result-count = Number of results
workflows-field-results-field = Results field

workflows-default-question = Is it interesting?
