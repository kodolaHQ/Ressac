# Constructeur de workflows, pages d'actions et récap, liste des actions.

## Libellés des exécutions

builder-trigger-scheduled = Planifiée
builder-trigger-manual = Manuelle
builder-trigger-agent = Par l'agent
builder-trigger-replay = Essai
builder-status-succeeded = Réussie
builder-status-partial = Partielle
builder-status-failed = Échouée
builder-status-interrupted = Interrompue
builder-status-grant-required = Accord requis
builder-status-lower-succeeded = réussie
builder-status-lower-partial = partielle
builder-status-lower-failed = échouée
builder-status-lower-interrupted = interrompue
builder-status-lower-grant-required = accord requis
builder-block-succeeded = réussi
builder-block-partial = partiel
builder-block-failed = échoué
builder-block-interrupted = interrompu
builder-block-not-run = pas lancé
builder-block-resumed = repris
builder-duration-running = en cours
builder-elements = { $count ->
    [one] { $count } élément
   *[other] { $count } éléments
}
builder-attempt-since = Essai depuis « { $start } »
builder-attempt-since-lower = essai depuis « { $start } »
builder-attempt-tag = essai
builder-no-run = Aucune exécution pour l'instant.
builder-loading = Chargement…

## Constructeur

builder-save-saved = Enregistré
builder-save-saving = Enregistrement…
builder-save-invalid = Non enregistré : { $reason }
builder-save-error = Erreur d'enregistrement : { $reason }
builder-awaiting-choice = l'agent a modifié le workflow, choisissez une version
builder-save-impossible = Enregistrement impossible
builder-no-free-code-file = aucun nom de fichier libre pour le bloc Code
builder-workflow-unreadable = workflow.json illisible
builder-grant-error = Accord non enregistré : { $reason }
builder-tab-workflow = Workflow
builder-tab-runs = Exécutions
builder-preview-action = Aperçu de la page
builder-preview-widget = Aperçu du widget
builder-rearrange = Réorganiser
builder-running = Exécution…
builder-launch = ▶ Lancer
builder-banner-proposal = L'agent a modifié le workflow pendant que le tien n'était pas enregistré.
builder-banner-take = Prendre sa version
builder-banner-keep = Garder la mienne
builder-banner-unreadable = workflow.json est illisible sur le disque (l'agent est peut-être en train de l'écrire).
builder-pane-agent = Agent
builder-pane-block = Bloc
builder-no-workflow-action = Cette action n'a pas de workflow (workflow.json), ou action.json est illisible.
builder-no-workflow-widget = Ce widget n'a pas de workflow (ni workflow.json ni harvest.mjs).
builder-launch-dialog = Lancer l'action
builder-cancel = Annuler
builder-canvas = Canevas du workflow
builder-palette = Blocs
builder-palette-no-web-action = L'action doit déclarer "web": true dans ses sources (action.json) : demandez-le à l'agent.
builder-palette-no-web-widget = Le widget doit déclarer "web": true : demandez-le à l'agent.
builder-node-error = Erreur
builder-node-warning = Avertissement

## Barre des exécutions

builder-replay = Rejouer depuis ce bloc
builder-replay-select = Sélectionnez un bloc
builder-replay-failed = Rejeu impossible : { $reason }
builder-unexpected-error = erreur inattendue

## Onglet d'un bloc

builder-block-unknown = Type de bloc inconnu : ses réglages ne s'éditent pas ici.
builder-field-name = Nom
builder-field-id = Identifiant
builder-field-choose = — choisir —
builder-field-default = Par défaut
builder-field-default-value = Par défaut ({ $value })
builder-field-template = gabarit
builder-field-template-help = Les { "{chemins}" } sont remplacés par les valeurs reçues
builder-field-one-per-line = Une valeur par ligne
builder-field-available = Champs disponibles : { $fields }
builder-output-title = À l'exécution choisie
builder-output-missing = Cette exécution n'est plus lisible.
builder-output-not-in-run = Ce bloc n'était pas dans cette exécution.
builder-output-status = Statut
builder-output-duration = Durée
builder-output-items = Éléments
builder-output-resumed = Sortie reprise de l'exécution { $run }
builder-output-trial = (essai)
builder-output-log = Journal ({ $count })
builder-output-output = Sortie
builder-output-truncated = Sortie (tronquée)

## Code d'un bloc

builder-code-title = Code
builder-code-unsaved = Code non enregistré
builder-code-save = Enregistrer le code
builder-code-changed = Le fichier a changé sur le disque
builder-code-reload = Recharger
builder-code-keep = Garder le mien
builder-code-confirm-switch = Le code de { $name } n'est pas enregistré. Changer de bloc quand même ? Il reste gardé dans cette fenêtre.
builder-code-confirm-close = Le code de { $names } n'est pas enregistré. Fermer quand même ? Il sera perdu.

## Panneaux d'une action ou d'un widget

builder-panel-account = Domaines avec compte
builder-panel-public = Domaines publics
builder-panel-none = aucun
builder-panel-none-f = aucune
builder-panel-input = Saisie demandée au lancement
builder-panel-layout = Consigne de mise en page
builder-panel-web-open = Accès au web : ouvert
builder-panel-hours = Heures prévues : { $hours }
builder-panel-max-duration = Durée maximale : { $minutes } min
builder-panel-notify = Notification à la fin : oui
builder-panel-config = Configuration
builder-panel-help-widget = Pour changer les sources ou la configuration, demandez-le à l'agent.
builder-panel-help-action = Pour changer les sources, la saisie ou la mise en page, demandez-le à l'agent.
builder-panel-select = Sélectionnez un bloc pour voir ses réglages.
builder-preview-trial = Aperçu d'un essai : pas le dernier résultat de l'action
builder-preview-no-page = Pas de page pour cette exécution.

## Page d'une action

action-unknown = Action inconnue
action-no-result = Aucun résultat
action-result-gone = Ce résultat n'existe plus
action-fallback-mention = mise en page simple
action-private = Les actions ne sont pas disponibles dans un espace privé
action-recap-private = Les récaps ne sont pas disponibles dans un espace privé
action-launch-failed = L'action n'a pas pu être lancée
action-not-yet = Pas encore de résultat
action-grant-required = Accord requis pour lire avec votre compte : { $domains }
action-authorize = Autoriser…
action-reads-public = Cette action lira : { $public }
action-reads-web = Cette action cherche et lit le web
action-reads-public-web = Cette action lira : { $public }, et cherche et lit le web
action-reads-allow = Autoriser
action-show-latest = Voir le dernier résultat
action-relaunch = Relancer
action-launch = Lancer
action-show-workflow = Voir le workflow
action-previous = Résultats précédents
action-stop = Arrêter
action-pending = En attente : deux actions tournent déjà
action-layout = Mise en page…
action-reading = Lecture de { $host }…
action-table-link = Lien
action-others = { $count ->
    [one] … et { $count } autre
   *[other] … et { $count } autres
}

## Récap dans un onglet

recap-loading = Chargement…
recap-gone = Ce récap a été fermé.
recap-meta = Récap de l'agent · { $date }
recap-live = en direct
recap-live-kept = { $count ->
    [one] en direct · { $count } retenue
   *[other] en direct · { $count } retenues
}
recap-writing = Rédige le récap…
recap-foot = Ce récap disparaît quand vous fermez l'onglet.

## Liste des actions

actions-title = Actions
actions-last-never = Jamais lancée
actions-empty = Aucune action. Demandez à l'agent de vous en créer une.
actions-input-required = Saisie requise : { $label }
actions-launch = Lancer
actions-show-workflow = Voir le workflow
actions-remove-grant = Retirer l'accord
actions-delete = Supprimer
actions-confirm-grant = Retirer l'accord de « { $name } » ? Ses exécutions, ses résultats et sa mémoire seront effacés.
actions-confirm-delete = Supprimer « { $name } » ? Son dossier ira dans la corbeille ; ses résultats et son accord seront effacés.
actions-cancel = Annuler

builder-family-sources = Sources
builder-family-lists = Listes
builder-family-ai = IA
builder-family-logic-code = Logique/Code
builder-family-output = Sortie
