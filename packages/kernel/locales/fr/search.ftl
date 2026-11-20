
# The agent's search band, its pauses and the address cards' lines (packages/kernel/src/mcp/server.ts).
kernel-search-address-step = Accord demandé pour une adresse
kernel-search-opening = Ouverture de { $url }
kernel-search-reading-page = Lecture de la page
kernel-search-query = Recherche : { $query }
kernel-search-reading-pages = Lecture de { $total ->
    [one] { $total } page
   *[other] { $total } pages
}, { $done ->
    [one] { $done } faite
   *[other] { $done } faites
}
kernel-search-blocked = Bloqué par une vérification. À vous : passez-la, puis Continuer.
kernel-search-sign-in = Connexion demandée. À vous : connectez-vous si vous le voulez, puis Continuer.
kernel-search-hand-verification = Bloqué par une vérification. À vous : { $reason }
kernel-search-hand-lost = Je ne trouve pas mon chemin. À vous : { $reason }
kernel-search-strange = Le surveillant a mis en pause : { $what } sans rapport avec « { $goal } »
kernel-search-opinion = Sans rapport apparent avec le but annoncé.
kernel-search-what-other-tab = lecture d'un autre onglet
kernel-search-what-capture = capture d'un autre onglet
kernel-search-what-history = lecture de l'historique
kernel-search-what-bookmarks = lecture des favoris
kernel-search-what-query = recherche « { $query } »
kernel-search-what-held = recherche contenant { $masked }

# The outflow rules: what a held query or address carries, and where the agent read it.
kernel-outflow-pause = Le surveillant a mis en pause : la recherche contient { $what } ({ $masked })
kernel-outflow-danger = Contient { $what } : { $masked }
kernel-outflow-refused = Recherche refusée : elle contient { $what } ({ $masked }).
kernel-outflow-read-in = { $what }, lu dans { $source }
kernel-outflow-kind-api-key = une clé d'accès
kernel-outflow-kind-private-key = une clé privée
kernel-outflow-kind-jwt = un jeton de connexion
kernel-outflow-kind-card = un numéro de carte
kernel-outflow-kind-iban = un IBAN
kernel-outflow-kind-nir = un numéro de sécurité sociale
kernel-outflow-kind-random = une chaîne qui ressemble à un secret
kernel-outflow-kind-email = une adresse e-mail
kernel-outflow-kind-phone = un numéro de téléphone
kernel-outflow-kind-digits = un numéro
kernel-outflow-kind-token = un identifiant
kernel-outflow-source-history = votre historique
kernel-outflow-source-bookmarks = vos favoris
kernel-outflow-source-sites = vos applis de site
kernel-outflow-source-site = l'appli de site { $id }
kernel-outflow-source-widget = le widget { $id }
kernel-outflow-source-action = l'action { $id }
kernel-outflow-source-hand-over = votre navigation pendant le passage de main
kernel-outflow-source-extensions = vos extensions
kernel-outflow-source-extension-console = la console d'une extension
kernel-outflow-source-devtools = les outils de développement
kernel-outflow-source-tabs = vos onglets
kernel-outflow-source-tool = un outil de l'agent

# What the agent does on a tab (the agent view, the tab's activity).
kernel-activity-reads-site = Lit { $site }
kernel-activity-reads-pages = Lit { $n ->
    [one] { $n } page
   *[other] { $n } pages
}
kernel-activity-goes-to = Va sur { $site }
kernel-activity-looks = Regarde { $site }
kernel-activity-acting = Agit sur la page
