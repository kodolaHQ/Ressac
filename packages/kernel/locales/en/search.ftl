
# The agent's search band, its pauses and the address cards' lines (packages/kernel/src/mcp/server.ts).
kernel-search-address-step = Waiting for your approval of an address
kernel-search-opening = Opening { $url }
kernel-search-reading-page = Reading the page
kernel-search-query = Search: { $query }
kernel-search-reading-pages = Reading { $total ->
    [one] { $total } page
   *[other] { $total } pages
}, { $done } done
kernel-search-blocked = Blocked by a verification. Your turn: complete it, then Continue.
kernel-search-sign-in = Sign-in requested. Your turn: sign in if you want, then Continue.
kernel-search-hand-verification = Blocked by a verification. Your turn: { $reason }
kernel-search-hand-lost = I can't find my way. Your turn: { $reason }

# The outflow rules: what a held query or address carries, and where the agent read it.
kernel-outflow-pause = The watcher paused: the search contains { $what } ({ $masked })
kernel-outflow-pause-series = The watcher paused: this series of searches seems to send something piece by piece ({ $masked })
kernel-outflow-danger = Contains { $what }: { $masked }
kernel-outflow-refused = Search refused: it contains { $what }.
kernel-outflow-refused-sent = Sending refused by the user: it contains { $what }.
kernel-outflow-read-in = { $what }, from { $source }
kernel-outflow-kind-api-key = an access key
kernel-outflow-kind-private-key = a private key
kernel-outflow-kind-jwt = a sign-in token
kernel-outflow-kind-card = a card number
kernel-outflow-kind-iban = an IBAN
kernel-outflow-kind-nir = a social security number
kernel-outflow-kind-random = a string that looks like a secret
kernel-outflow-kind-email = an email address
kernel-outflow-kind-phone = a phone number
kernel-outflow-kind-digits = a number
kernel-outflow-kind-token = an identifier
kernel-outflow-kind-series = a series of searches sending something piece by piece
kernel-outflow-kind-clicks = a series of followed links sending something piece by piece
kernel-outflow-source-history = your history
kernel-outflow-source-bookmarks = your bookmarks
kernel-outflow-source-sites = your site apps
kernel-outflow-source-site = the site app { $id }
kernel-outflow-source-widget = the widget { $id }
kernel-outflow-source-action = the action { $id }
kernel-outflow-source-hand-over = your browsing during the hand-over
kernel-outflow-source-devtools = the developer tools
kernel-outflow-source-tabs = your tabs
kernel-outflow-source-tool = one of the agent's tools

# What the agent does on a tab (the agent view, the tab's activity).
kernel-activity-reads-site = Reading { $site }
kernel-activity-reads-pages = Reading { $n ->
    [one] { $n } page
   *[other] { $n } pages
}
kernel-activity-goes-to = Going to { $site }
kernel-activity-looks = Looking at { $site }
kernel-activity-acting = Acting on the page
