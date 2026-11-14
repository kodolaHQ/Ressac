# Les textes côté Firefox : bannières, import, fenêtres de site, extensions, menus.

# Import depuis un autre navigateur (notification de fin, erreurs).
chrome-import-count-bookmarks = { $count ->
    [one] { $shown } favori
   *[other] { $shown } favoris
}
chrome-import-count-history = { $count ->
    [one] { $shown } page d'historique
   *[other] { $shown } pages d'historique
}
chrome-import-count-passwords = { $count ->
    [one] { $shown } mot de passe
   *[other] { $shown } mots de passe
}
chrome-import-count-spaces = { $count ->
    [one] { $shown } élément de barre latérale
   *[other] { $shown } éléments de barre latérale
}
chrome-import-count-tabs = { $count ->
    [one] { $shown } onglet ouvert
   *[other] { $shown } onglets ouverts
}
chrome-import-type-bookmarks = favoris
chrome-import-type-history = historique
chrome-import-type-passwords = mots de passe
chrome-import-type-spaces = espaces et onglets épinglés
chrome-import-type-tabs = onglets ouverts
chrome-import-partial = Import terminé en partie
chrome-import-done = Import terminé
chrome-import-not-imported = Non importé : { $failed }
chrome-import-safari-denied = accès refusé : autorisez Ressac dans Réglages Système › Confidentialité et sécurité › Accès complet au disque
chrome-import-keychain-denied = accès au trousseau refusé
chrome-import-profile-unreadable = profil { $name } illisible
chrome-import-file-unreadable = fichier illisible : fermez { $name } puis réessayez
chrome-import-no-zen-profile = profil Zen introuvable
chrome-import-no-space = aucun espace trouvé
chrome-import-format = format { $name } non reconnu
chrome-import-keychain-test = trousseau non consulté pendant les tests
chrome-import-running = Un import est déjà en cours
chrome-import-no-browser = Ce navigateur n'est pas sur ce Mac
chrome-import-nothing = Rien à importer
chrome-import-no-profile = Profil introuvable
chrome-import-csv-pick = Choisissez l'export de vos mots de passe (CSV)
chrome-import-no-file = Aucun fichier choisi
chrome-import-csv-unreadable = Ce fichier n'a pas pu être lu.
chrome-import-csv-invalid = Ce fichier n'est pas un export de mots de passe (CSV).

# Bannière de demande d'autorisation d'un site.
chrome-banner = { $site } veut { $what }
chrome-banner-link = { $text } : { $link }
chrome-banner-label = Demande d'autorisation
chrome-banner-deny = Refuser
chrome-banner-allow = Autoriser
chrome-perm-use = utiliser { $what }
chrome-perm-media-camera = votre caméra
chrome-perm-media-micro = votre micro
chrome-perm-notifications = vous envoyer des notifications
chrome-perm-geolocation = connaître votre position
chrome-perm-fullscreen = passer en plein écran
chrome-perm-clipboard-sanitized-write = écrire dans le presse-papiers
chrome-perm-open-app = ouvrir un lien dans une autre application
chrome-perm-read-tab = lire un onglet
chrome-perm-devtools = utiliser les outils de développement
chrome-perm-widget-data = voir les données d'un widget
chrome-perm-extension = activer une extension
chrome-perm-extension-console = voir toute la console d'une extension
chrome-perm-agent-address = ouvrir une adresse écrite par l'agent
chrome-perm-other = une permission inconnue
chrome-perm-screen-share = partager votre écran
chrome-perm-drm = lire des contenus protégés (DRM)
chrome-perm-midi = utiliser vos appareils MIDI

# Menu « Navigation » et bandeau de recherche de l'agent.
chrome-menu-navigation = Navigation
chrome-menu-forget-permissions = Oublier les autorisations de ce site
chrome-search-label = Recherche de l'agent
chrome-search-continue = Continuer
chrome-search-stop = Arrêter
chrome-search-close = Fermer
chrome-search-stats = { $pages ->
    [one] { $pages } page lue
   *[other] { $pages } pages lues
} · { $duration }
chrome-duration-seconds = { $s } s
chrome-duration-minutes = { $m } min { $s }

# Notifications au démarrage et confirmation avant de quitter un site.
chrome-session-set-aside = Ressac repart avec une session neuve. L'ancienne est gardée dans { $path }
chrome-data-reset = Ressac repart à neuf. Ses anciennes données sont gardées dans { $backup } (Réglages › Données). Vos projets n'ont pas bougé.
chrome-data-unknown-format = Ressac ne reconnaît pas le format de ses données : il repart à neuf et les garde dans { $backup }. Vos projets n'ont pas bougé.
chrome-telemetry-stop = Couper l'envoi
chrome-telemetry-ok = D'accord
chrome-leave-title = Quitter ce site ?
chrome-leave-text = Les modifications que vous avez faites ne seront peut-être pas enregistrées.
chrome-leave-leave = Quitter
chrome-leave-stay = Rester

# Mode design : où il ne marche pas, et l'avertissement de capture d'une appli de site.
chrome-design-unavailable = Le mode design marche sur les applis de l'agent, les applis de site et les projets branchés par un Claude Code
chrome-design-unavailable-site = Le mode design marche dans les pages du site et sur l'accueil, pas sur la carte d'accord, une page de connexion ni en plein écran
chrome-design-capture-warning = L'extrait et la capture de cet élément iront à l'agent.

# Fenêtre d'une appli de site : barre, carte d'accord, accueil.
chrome-site-back = Reculer
chrome-site-forward = Avancer
chrome-site-home = Accueil de l'appli
chrome-site-reload = Recharger
chrome-site-search-address = Chercher la nouvelle adresse
chrome-site-link-blocked = Lien vers { $domain } bloqué
chrome-site-open-tab = Ouvrir dans un onglet
chrome-site-enter = Entrer dans le site
chrome-site-design = Mode design
chrome-site-design-title = Mode design ({ $shortcut })
chrome-site-design-menu = Menu du mode design
chrome-site-basket = Panier
chrome-site-review = Voir les modifications de l'agent
chrome-grant-title = Autoriser les retouches de « { $name } » ?
chrome-grant-domains = Domaines
chrome-grant-tracked = Adresses suivies
chrome-grant-sign-in = Connexion
chrome-grant-frames = Cadres
chrome-grant-injects = Injecte
chrome-grant-resume = Reprend les vidéos à la minute
chrome-grant-warning = Ses retouches voient et modifient les pages de ces domaines. Une image ajoutée à la page peut encore envoyer des données à un autre site.
chrome-grant-refuse = Ouvrir sans retouches
chrome-grant-allow = Autoriser

# Titres des onglets de pages internes.
chrome-page-settings = Réglages
chrome-page-release-notes = Nouveautés
chrome-page-workflow = Workflow — { $name }
chrome-page-review = Relecture — { $name }

# Actions : réponses de l'interface quand le service ne répond pas.
chrome-actions-no-kernel = Le service des actions ne répond pas (agent arrêté ?)
chrome-actions-profile-refused = Ce profil ne peut pas servir à un accord

# Barre d'adresse, essentiels, panneau ⌃Tab, pastille de l'agent, badge d'appli, erreurs de page.
chrome-ui-back = Reculer
chrome-ui-forward = Avancer
chrome-ui-stop = Arrêter
chrome-ui-reload = Recharger
chrome-ui-compact = Mode compact
chrome-ui-compact-leave = Quitter le mode compact
chrome-ui-address = Rechercher ou saisir une adresse
chrome-ui-essentials = Essentiels
chrome-ui-unload = Décharger
chrome-ui-remove = Retirer
chrome-ui-recent-tabs = Onglets récents
chrome-ui-page-error = Impossible d'ouvrir cette page.
chrome-ui-page-crashed = Cette page a planté.
chrome-ui-unmute = Réactiver le son de l'onglet
chrome-ui-mute = Couper le son de l'onglet
chrome-ui-access = Accès de l'agent à cet onglet
chrome-ui-widget-unreadable = Widget illisible : { $reason }
chrome-ui-loading = Chargement…
chrome-ui-widget-preview = Aperçu : données non gardées dans cette exécution
chrome-badge-basket = Panier ({ $count })
chrome-pill-open = Voir l'onglet de l'agent
chrome-pill-grow = Agrandir
chrome-pill-reduce = Réduire
chrome-pill-hide = Masquer

# Mode vim dans les pages.
chrome-vim-paused = vim en pause · ⇧Échap pour reprendre
chrome-host-stopped = Le noyau de l'agent s'est arrêté.
