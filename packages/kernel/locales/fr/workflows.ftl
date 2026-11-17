# Textes des workflows que l'utilisateur lit : constructeur (validation, avertissements, blocs), journaux.

workflows-invalid-prefix = Workflow invalide :

# Validation (après le préfixe).
workflows-val-at = { $name } : { $message }
workflows-val-duplicate-id = id de bloc en double : { $id }
workflows-val-unknown-type = type inconnu : { $type }
workflows-val-per-item-no = { $id }.perItem : le type { $type } ne travaille pas élément par élément
workflows-val-budget = { $id }.budgetSeconds : { $max } au plus
workflows-val-keepdays-reuse = { $id }.keepDays : seulement avec reuse
workflows-val-link-absent = lien vers un bloc absent : { $id }
workflows-val-no-output = aucune sortie
workflows-val-many-outputs = plusieurs sorties : { $ids }
workflows-val-cycle = cycle : { $cycle }
workflows-val-missing-input = { $id } : entrée manquante (relie un bloc avant lui)
workflows-val-output-page-denied = output : to "page" seulement dans une action
workflows-val-output-page-required = output : une action rend une page (to: "page")
workflows-val-streaming-action = output.live : pas dans une action
workflows-val-web-required = web.search : le widget doit déclarer "web": true

# Messages des problèmes de forme.
workflows-val-block-id = id de bloc invalide (a-z, 0-9 et - , 40 caractères au plus)
workflows-val-mjs-file = fichier .mjs du dossier du widget attendu
workflows-val-key-path = chemin de clé invalide
workflows-val-unknown-to = to inconnu : { $value }
workflows-val-type-string = texte attendu
workflows-val-type-number = nombre attendu
workflows-val-type-int = nombre entier attendu
workflows-val-type-boolean = booléen attendu
workflows-val-type-array = liste attendue
workflows-val-type-object = objet attendu
workflows-val-type-other = { $expected } attendu
workflows-val-missing = manquant ({ $expected })
workflows-val-max-items = { $n ->
    [one] { $text } élément au plus
   *[other] { $text } éléments au plus
}
workflows-val-max-chars = { $n ->
    [one] { $text } caractère au plus
   *[other] { $text } caractères au plus
}
workflows-val-less-than = doit être inférieur à { $n }
workflows-val-at-most = { $n } au plus
workflows-val-min-items = { $n ->
    [one] au moins { $text } élément
   *[other] au moins { $text } éléments
}
workflows-val-min-chars = { $n ->
    [one] au moins { $text } caractère
   *[other] au moins { $text } caractères
}
workflows-val-empty = vide
workflows-val-greater-than = doit être supérieur à { $n }
workflows-val-at-least = au moins { $n }
workflows-val-one-value = { $values } attendu
workflows-val-one-of = une valeur parmi { $values } attendue
workflows-val-unknown-key = paramètre inconnu

# Lecture et enregistrement.
workflows-file-leaves-folder = workflow.json sort du dossier du widget
workflows-file-too-big = workflow.json dépasse { $kb } Ko
workflows-file-bad-json = workflow.json illisible (pas du JSON valide)
workflows-file-unreadable = workflow.json illisible
workflows-save-widget-not-found = Widget introuvable
workflows-save-code-absent = Non enregistré : fichier { $source } absent
workflows-save-too-big = Workflow trop gros : { $kb } Ko au plus
workflows-code-invalid-name = Nom de fichier invalide
workflows-code-too-big = Fichier trop gros : { $kb } Ko au plus
workflows-code-leaves-folder = Le fichier sort du dossier du widget
workflows-code-unreadable = Fichier illisible
workflows-code-write-failed = Écriture impossible

# Avertissements.
workflows-warn-streaming = rien à publier au fil de l'eau : l'entrée de la sortie n'est pas traitée élément par élément
workflows-warn-web-no-duration = sans maxDurationMinutes, ce widget peut être coupé à 150 s : demande à l'agent de déclarer maxDurationMinutes
workflows-warn-input = { "{input}" } : l'action ne déclare pas de saisie (input)
workflows-warn-domain = domaine non déclaré : { $host }
workflows-warn-config = config.{ $key } absent de la configuration du widget

# Exécution.

# Blocs : noms et descriptions.
workflows-block-ai-sort = Trier avec l'IA locale
workflows-block-ai-sort-desc = Note chaque élément avec l'IA locale et garde ceux qui passent le seuil.
workflows-block-ai-write = Rédiger avec l'IA
workflows-block-ai-write-desc = Fait écrire un texte à l'IA à partir d'une consigne.
workflows-block-code = Code
workflows-block-code-desc = Exécute un fichier .mjs du widget sur l'entrée reçue.
workflows-block-list-dedupe = Dédoublonner
workflows-block-list-dedupe-desc = Retire les éléments qui ont la même valeur pour les clés données.
workflows-block-list-keep = Garder les N premiers
workflows-block-list-keep-desc = Garde les premiers éléments de la liste.
workflows-block-list-new = Garder les nouveaux
workflows-block-list-new-desc = Ne garde que les éléments pas encore vus lors des exécutions précédentes.
workflows-block-output = Sortie vers le widget
workflows-block-output-desc = Envoie le résultat au widget (ou ailleurs).
workflows-block-source-feed = Lire des flux RSS
workflows-block-source-feed-desc = Lit des flux RSS ou Atom et donne leurs articles.
workflows-block-source-fetch = Récupérer une adresse
workflows-block-source-fetch-desc = Récupère le contenu d'une adresse, en texte ou en JSON.
workflows-block-source-page = Lire une page
workflows-block-source-page-desc = Lit le texte d'une page web.
workflows-block-web-search = Chercher sur le web
workflows-block-web-search-desc = Cherche sur DuckDuckGo et rend les résultats (titre, adresse, extrait).

# Blocs : champs.
workflows-help-templates = Les { "{chemins}" } sont remplacés par les valeurs de l'élément.
workflows-help-no-value = Sans valeur : pour toujours.
workflows-field-per-item = Un élément à la fois
workflows-field-per-item-help = Applique le bloc à chaque élément de la liste reçue.
workflows-field-on-error = En cas d'erreur
workflows-field-budget = Durée maximale (secondes)
workflows-field-budget-help = 170 s au plus, ou la durée maximale de l'exécution
workflows-field-reuse = Réutiliser un résultat précédent
workflows-field-reuse-help = Chemin de la clé qui identifie l'élément.
workflows-field-keep-days = Garder (jours)
workflows-field-question = Question
workflows-field-question-help = Ce que l'IA locale doit juger, par exemple « Est-ce intéressant ? ».
workflows-field-judged-text = Texte à juger
workflows-field-threshold = Seuil
workflows-field-score-field = Champ de la note
workflows-field-prompt = Consigne
workflows-field-answer-field = Champ de la réponse
workflows-field-json = Réponse en JSON
workflows-field-max-text = Taille maximale du texte
workflows-field-file = Fichier
workflows-field-file-help = Un fichier .mjs du dossier du widget.
workflows-field-call = Appel
workflows-field-keys = Clés
workflows-field-keys-help = Chemins des valeurs qui identifient un élément.
workflows-field-count = Nombre d'éléments
workflows-field-key = Clé
workflows-field-key-help = Chemin de la valeur qui identifie un élément.
workflows-field-forget-days = Oublier après (jours)
workflows-field-destination = Destination
workflows-field-live = Publier au fil de l'eau
workflows-field-live-help = Chaque élément fini est montré sans attendre la fin de l'exécution.
workflows-field-feed-urls = Adresses des flux
workflows-field-address = Adresse
workflows-field-format = Format
workflows-field-result-field = Champ du résultat
workflows-field-account = Avec mon compte
workflows-field-scroll = Écrans à faire défiler
workflows-field-scroll-help = Pour une page qui charge en défilant. Vide ou 0 : pas de défilement.
workflows-field-search-query = Recherche
workflows-field-result-count = Nombre de résultats
workflows-field-results-field = Champ des résultats

workflows-default-question = Est-ce intéressant ?
