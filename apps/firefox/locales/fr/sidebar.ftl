# The sidebar and what opens from it: tabs, spaces, command bar, history, downloads, update card, tips.

sidebar-cancel = Annuler
sidebar-delete = Supprimer
sidebar-create = Créer
sidebar-save = Enregistrer

sidebar-new-tab = Nouvel onglet
sidebar-new-folder = Nouveau dossier
sidebar-tool-agent = Agent ({ $key })
sidebar-tool-apps = Applications ({ $key })
sidebar-tool-actions = Actions
sidebar-tool-settings = Réglages ({ $key })
sidebar-tools = Outils
sidebar-downloads = Téléchargements

sidebar-agent-section = Agent
sidebar-agent-tabs = Onglets de l'agent
sidebar-agent-no-chat = Sans discussion
sidebar-agent-group-open = Ouvrir « { $name } » dans le panneau de l'agent
sidebar-agent-group-fold = Replier « { $name } »
sidebar-agent-group-unfold = Déplier « { $name } »
sidebar-tab-keep = Garder dans mes onglets
sidebar-tab-close-menu = Fermer
sidebar-tab-pin = Épingler
sidebar-tab-essential = Ajouter aux essentiels
sidebar-tab-send = Envoyer vers { $space }
sidebar-tab-new-window = Déplacer vers une nouvelle fenêtre
sidebar-tab-loading = Chargement
sidebar-tab-yours = à vous
sidebar-tab-by-agent = Ouvert par l'agent
sidebar-tab-close = Fermer l'onglet

sidebar-pinned-rename = Renommer
sidebar-pinned-remove = Retirer
sidebar-pinned-move-into = Déplacer dans { $folder }
sidebar-pinned-move-out = Sortir du dossier
sidebar-pinned-name = Nom de l'onglet épinglé
sidebar-folder-name = Nom du dossier
sidebar-folder-delete = Supprimer le dossier

sidebar-space-new = Nouvel espace
sidebar-space-settings = Réglages
sidebar-space-settings-title = Réglages de l'espace
sidebar-space-private = { $name } (privé)
sidebar-space-delete-title = Supprimer l'espace
sidebar-space-delete = Supprimer l'espace « { $name } » ?
sidebar-space-delete-tabs =
    Supprimer l'espace « { $name } » et ses { $tabs ->
        [one] { $tabs } onglet
       *[other] { $tabs } onglets
    } ?
sidebar-space-delete-pinned =
    { $pinned ->
        [one] { $pinned } site épinglé
       *[other] { $pinned } sites épinglés
    } et { $folders ->
        [one] { $folders } dossier
       *[other] { $folders } dossiers
    } seront perdus.
sidebar-space-delete-logins = Les connexions de cet espace seront perdues.
sidebar-space-passport = Passeport
sidebar-space-passport-count =
    { $count ->
        [one] Son passeport contient { $count } donnée.
       *[other] Son passeport contient { $count } données.
    }
sidebar-space-passport-drop = Supprimer aussi son passeport
sidebar-space-passport-drop-failed = Le passeport n'a pas pu être supprimé : rien n'a changé. Réessayez, ou décochez la case pour le garder.
sidebar-space-passport-dropped-only = Le passeport a été supprimé, mais l'espace n'a pas changé.
sidebar-space-icon = Icône
sidebar-space-icons = Icônes proposées
sidebar-space-name = Nom de l'espace
sidebar-space-name-placeholder = Nom
sidebar-space-aura = Aura
sidebar-space-aura-named = Aura { $name }
sidebar-space-private-label = Espace privé
sidebar-space-private-note = L'agent ne voit pas ces onglets, ne lit rien, n'a pas les outils de développement, et rien n'est retenu dans sa mémoire.
sidebar-space-profile = Profil de connexion
sidebar-space-profile-choose = Choisir un profil…
sidebar-space-profile-note = Cookies, comptes connectés, autorisations des sites. Changer de profil : les onglets de l'espace se rechargent, vous devrez peut-être vous reconnecter.
sidebar-profile-new = Nouveau profil
sidebar-profile-own = Son propre profil
sidebar-profile-shared = Partagé avec « { $names } »

sidebar-command-bar = Barre de commande
sidebar-command-placeholder = Rechercher ou saisir une adresse
sidebar-command-home = Page d'accueil
sidebar-command-open = Ouvrir { $target }
sidebar-command-search = Rechercher « { $query } »
sidebar-command-input = « { $input } »
sidebar-command-param-help = { $label } · Entrée pour lancer · Échap pour revenir
sidebar-command-actions-down = Le service des actions ne répond pas
sidebar-command-mode-search = Chercher
sidebar-command-mode-ask = Demander
sidebar-command-mode-hint = ⇥ pour changer
sidebar-command-ask-placeholder = Posez une question
sidebar-command-ask-agent = Demander à l'agent
sidebar-command-ask-working = Recherche dans l'historique…
sidebar-command-ask-down = L'agent ne répond pas. Réessayez dans un instant.
sidebar-ask-today = aujourd'hui
sidebar-ask-yesterday = hier
sidebar-ask-days-ago = il y a { $days } jours
sidebar-section-actions = Actions
sidebar-section-commands = Commandes
sidebar-section-tabs = Onglets ouverts
sidebar-section-apps = Applis
sidebar-section-history = Historique
sidebar-section-bookmarks = Favoris
sidebar-badge-action = Action
sidebar-badge-command = Commande
sidebar-command-choice = { $setting } : { $value }
sidebar-command-aura-on = Animer l'aura
sidebar-command-aura-off = Figer l'aura
sidebar-command-home-on = Ouvrir sur la page d'accueil au lancement
sidebar-command-home-off = Ne plus ouvrir sur la page d'accueil au lancement
sidebar-command-hints-on = Afficher les astuces
sidebar-command-hints-off = Masquer les astuces
sidebar-command-settings-section = Réglages › { $section }
sidebar-command-vim-on = Activer le mode vim
sidebar-command-vim-off = Désactiver le mode vim
sidebar-badge-tab = Onglet
sidebar-badge-app = Appli
sidebar-badge-history = Historique
sidebar-badge-bookmark = Favori

sidebar-site-bar = Applis de site
sidebar-site-to-essentials = Mettre dans les essentiels
sidebar-site-remove-bar = Retirer de la barre
sidebar-call-running = Appel en cours : { $title }
sidebar-call-back = Revenir à l'appel : { $title }
sidebar-call-mic-off = Couper le micro
sidebar-call-mic-on = Activer le micro
sidebar-call-camera-off = Couper la caméra
sidebar-call-camera-on = Activer la caméra
sidebar-media-running = Lecture en cours : { $title }
sidebar-media-back = Revenir à l'onglet : { $title }
sidebar-media-pause = Mettre en pause
sidebar-media-resume = Reprendre la lecture

sidebar-update-title = Ressac { $version } est prête
sidebar-update-title-plain = Une mise à jour est prête
sidebar-update-installs = Elle s'installe au redémarrage.
sidebar-update-restart = Redémarrer maintenant
sidebar-update-later = Plus tard
sidebar-update-idle = À jour
sidebar-update-checking = Recherche…
sidebar-update-downloading-version = Téléchargement de { $version }…
sidebar-update-downloading = Téléchargement…
sidebar-update-ready-version = { $version } prête, installée au redémarrage
sidebar-update-ready = Mise à jour prête, installée au redémarrage
sidebar-update-unreachable = Impossible de vérifier pour le moment
sidebar-update-failed = La mise à jour a échoué

sidebar-downloads-close = Fermer les téléchargements
sidebar-download-in-progress = En cours
sidebar-download-done = Terminé
sidebar-download-canceled = Annulé
sidebar-download-interrupted = Interrompu
sidebar-download-of = { $received } sur { $total }
sidebar-download-open = Ouvrir
sidebar-download-show = Afficher dans le Finder
sidebar-download-none = Aucun téléchargement pendant cette session.
sidebar-size-b = { $n } o
sidebar-size-kb = { $n } Ko
sidebar-size-mb = { $n } Mo
sidebar-size-gb = { $n } Go

sidebar-history = Historique
sidebar-history-search = Rechercher dans l'historique
sidebar-history-clear = Effacer l'historique
sidebar-history-clear-hour = Dernière heure
sidebar-history-clear-all = Tout
sidebar-history-today = Aujourd'hui
sidebar-history-yesterday = Hier
sidebar-history-close = Fermer l'historique
sidebar-history-forget = Oublier le texte retenu
sidebar-history-private = Espace privé
sidebar-history-kept = Texte retenu pour l'agent
sidebar-history-no-result = Aucun résultat.
sidebar-history-empty = L'historique est vide.

sidebar-access-label = Accès de l'agent
sidebar-access-title = { $agent } a accès à cet onglet
sidebar-access-read = Lecture de la page
sidebar-access-console = Console et erreurs
sidebar-access-network = Réseau
sidebar-access-performance = Performances et mémoire
sidebar-access-act = Agir sur la page
sidebar-access-cut = Couper
sidebar-access-note = Cette conversation · tombe si l'onglet change de site
sidebar-access-cut-all = Couper l'accès

sidebar-grant-title-action = Autoriser l'action « { $name } » à lire avec votre compte
sidebar-grant-title-widget = Autoriser « { $name } » à lire avec votre compte
sidebar-grant-account-action = Cette action veut lire { $domains } avec votre compte, connecté avec le profil choisi.
sidebar-grant-account-widget = Ce widget veut lire { $domains } avec votre compte, connecté avec le profil choisi.
sidebar-grant-public = Et pourra contacter : { $domains }.
sidebar-grant-public-none = Et ne contactera aucun autre site.
sidebar-grant-private = Les profils des espaces privés ne sont jamais proposés.
sidebar-grant-error = Profils illisibles : { $error }
sidebar-grant-loading = Chargement des profils…
sidebar-grant-none = Aucun profil utilisable.
sidebar-grant-allow = Autoriser

sidebar-extensions = Extensions
sidebar-extensions-none = Aucune extension active.
sidebar-extensions-pin = Épingler
sidebar-extensions-unpin = Détacher
sidebar-extensions-update-pending = { $name } : mise à jour en attente de votre accord.
sidebar-extensions-update-review = Revoir la mise à jour
sidebar-extensions-manage = Gérer les extensions

sidebar-api-widgets-down = Le service des widgets ne répond pas (agent arrêté ?)
sidebar-api-profile-grant = Ce profil ne peut pas servir à un accord
sidebar-api-agent-silent = L'agent ne répond pas

sidebar-next-today = aujourd'hui { $time }
sidebar-next-tomorrow = demain { $time }

sidebar-shortcut-command = Barre de commande
sidebar-shortcut-address = Barre d'adresse
sidebar-shortcut-jumpTab = Aller à un onglet
sidebar-shortcut-closeTab = Fermer l'onglet
sidebar-shortcut-back = Page précédente
sidebar-shortcut-forward = Page suivante
sidebar-shortcut-reload = Recharger
sidebar-shortcut-newWindow = Nouvelle fenêtre
sidebar-shortcut-agent = Panneau de l'agent
sidebar-shortcut-history = Historique
sidebar-shortcut-settings = Réglages
sidebar-shortcut-reopen = Rouvrir l'onglet fermé
sidebar-shortcut-reloadHard = Recharger sans cache
sidebar-shortcut-closeWindow = Fermer la fenêtre
sidebar-shortcut-downloads = Téléchargements
sidebar-shortcut-compact = Mode compact
sidebar-shortcut-apps = Applications
sidebar-shortcut-design = Mode design
sidebar-binding-modifier = Utilisez ⌘ ou ⌃
sidebar-binding-reserved = Réservé par macOS ou l'édition de texte
sidebar-binding-taken = Déjà utilisé par { $action }

sidebar-tip-title = Astuce
sidebar-tip-try = Essayer
sidebar-tip-next = Une autre
sidebar-tip-close = Fermer l'astuce
sidebar-tip-ctrl-tab = Passez d'un onglet récent à l'autre avec ⌃Tab ; maintenez ⌃ pour choisir dans la liste.
sidebar-tip-cmd-t = { $key } ouvre un onglet ou retrouve une page parmi vos onglets, votre historique et le web.
sidebar-tip-cmd-l = { $key } modifie l'adresse de l'onglet affiché.
sidebar-tip-cmd-j = { $key } ouvre ou ferme le panneau de l'agent.
sidebar-tip-spaces = Un espace par sujet : le + en bas de la barre en crée un, avec son aura.
sidebar-tip-design-mode = Le crayon en haut de la barre lance le mode design : montrez un élément de la page à l'agent.
sidebar-first-ok = Compris
sidebar-first-agent-title = L'agent
sidebar-first-agent-text = Claude Code ou Codex travaille dans un conteneur à part, sur votre Mac. Il ne lit un onglet ou n'agit sur une page qu'avec votre accord, et un halo entoure la page quand il agit.
sidebar-first-design-title = Le mode design
sidebar-first-design-text = Cliquez sur un élément de la page pour y laisser une remarque. Vos remarques vont dans le panier, puis à l'agent.
sidebar-first-actions-title = Les actions
sidebar-first-actions-text = Une action est une petite appli que l'agent construit pour vous. Elle ne lit vos comptes qu'avec votre accord.

sidebar-emoji-home = Maison
sidebar-emoji-work = Travail
sidebar-emoji-school = École
sidebar-emoji-reading = Lecture
sidebar-emoji-writing = Écriture
sidebar-emoji-code = Code
sidebar-emoji-science = Science
sidebar-emoji-ideas = Idées
sidebar-emoji-games = Jeux
sidebar-emoji-music = Musique
sidebar-emoji-movies = Films
sidebar-emoji-tv-shows = Séries
sidebar-emoji-photo = Photo
sidebar-emoji-art = Art
sidebar-emoji-crafts = Loisirs créatifs
sidebar-emoji-board-games = Jeux de société
sidebar-emoji-travel = Voyage
sidebar-emoji-map = Carte
sidebar-emoji-holidays = Vacances
sidebar-emoji-car = Voiture
sidebar-emoji-groceries = Courses
sidebar-emoji-shopping = Shopping
sidebar-emoji-cooking = Cuisine
sidebar-emoji-coffee = Café
sidebar-emoji-money = Argent
sidebar-emoji-stocks = Bourse
sidebar-emoji-bank = Banque
sidebar-emoji-bills = Factures
sidebar-emoji-calendar = Agenda
sidebar-emoji-projects = Projets
sidebar-emoji-folder = Dossier
sidebar-emoji-news = Actualités
sidebar-emoji-health = Santé
sidebar-emoji-sport = Sport
sidebar-emoji-wellbeing = Bien-être
sidebar-emoji-garden = Jardin
sidebar-emoji-pets = Animaux
sidebar-emoji-family = Famille
sidebar-emoji-baby = Bébé
sidebar-emoji-gifts = Cadeaux
sidebar-emoji-football = Football
sidebar-emoji-side-project = Projet perso
sidebar-emoji-diy = Bricolage
sidebar-emoji-real-estate = Immobilier
sidebar-emoji-world = Monde
sidebar-emoji-favorites = Favoris
sidebar-emoji-private = Privé
sidebar-emoji-commuting = Déplacements
sidebar-handle = Largeur de la barre des onglets
