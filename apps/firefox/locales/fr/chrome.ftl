# Les textes côté Firefox : bannières, import, fenêtres de site, menus.

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
chrome-import-access-denied = macOS a refusé l'accès : autorisez Ressac dans Réglages Système › Confidentialité et sécurité › Fichiers et dossiers
chrome-import-access-cancelled = Accès non accordé : sans lui, Ressac ne peut pas lire les données de { $name }.
chrome-import-access-wrong = macOS refuse encore l'accès aux données de { $name }. Choisissez le dossier proposé, ou autorisez Ressac dans Réglages Système › Confidentialité et sécurité › Fichiers et dossiers.
chrome-import-access-first = Autorisez d'abord l'accès aux données de { $name }
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
chrome-start-title = Ouvrir l'appli « { $name } » ?
chrome-start-url = Adresse
chrome-start-page = Page de référence
chrome-start-warning = L'agent a écrit cette adresse. Une adresse peut transmettre des données au site qu'elle ouvre : ouvrez-la seulement si vous la reconnaissez.
chrome-start-refuse = Ne pas ouvrir
chrome-start-open = Ouvrir
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
# The padlock before the host in the address bar (https), and the open one for plain http to another machine.
chrome-ui-connection-secure = Connexion sécurisée
chrome-ui-connection-insecure = Connexion non sécurisée
chrome-ui-address = Rechercher ou saisir une adresse
chrome-ui-essentials = Essentiels
chrome-ui-unload = Décharger
chrome-ui-keep-loaded = Garder chargé (notifications)
chrome-ui-remove = Retirer
chrome-ui-remove-essentials = Retirer des essentiels
chrome-ui-open-window = Ouvrir en fenêtre
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
chrome-display-denied = Affichage refusé : il contient &lt;link&gt;, &lt;meta http-equiv&gt; ou des règles de spéculation, qui feraient sortir des données. Voir guides/widgets.md.

# Touch ID après le « Oui » d'une carte de masquage : macOS l'affiche « Ressac essaie de … ».
chrome-mask-reauth-reveal = montrer { $name } à l'agent
chrome-mask-reauth-fill = remplir { $name } sur { $where }
chrome-mask-reauth-devtools = débloquer les outils de développement sur { $site }
chrome-mask-reauth-lift = lever le verrou de l'atelier
chrome-mask-fill-kind = Remplir { $name } sur { $site } ?
chrome-mask-fill-rows = Remplir { $n } champs sur { $site } avec votre passeport ?
chrome-mask-fill-rows-plain = Remplir { $n ->
    [one] ce champ
   *[other] { $n } champs
} sur { $site } ?
chrome-mask-fill-row = { $field } : { $name }
chrome-mask-fill-remember = Retenir { $site } pour { $name }
chrome-mask-fill-remember-failed = Le site n'a pas pu être retenu.
chrome-mask-fill-other-profile = Cette donnée vient de votre passeport « { $profile } », pas de celui de cet onglet.
chrome-mask-fill-no-passport = Cet onglet n'a pas de passeport : c'est un onglet de l'agent ou une appli de site. Remplissez ce champ vous-même, ou ouvrez la page dans un de vos espaces.
chrome-mask-fill-missing =
    Votre passeport n'a pas { $kind ->
        [prenoms] de prénom
        [nom_famille] de nom de famille
        [nom_complet] de nom
        [naissance] de date de naissance
        [adresse] d'adresse
        [adresse_voie] de rue
        [code_postal] de code postal
        [ville] de ville
        [tel] de téléphone
        [email] d'e-mail
        [iban] d'IBAN
        [secu] de numéro de sécu
        [piece] de numéro de pièce d'identité
        [plaque] de plaque d'immatriculation
       *[other] cette donnée
    }.

## « Cacher pour l'agent » (chrome/window/hide-layer.ts, ui/HideApp.svelte)

chrome-hide = Cacher pour l'agent
chrome-hide-question = Cacher « { $text } » pour l'agent ?
chrome-hide-type = Type
chrome-hide-given = Prénom(s)
chrome-hide-family = Nom
chrome-hide-site = Sur { $site } et vos autres sources
chrome-hide-cancel = Annuler
chrome-hide-confirm = Cacher
chrome-hide-reauth = cacher une donnée pour l'agent
chrome-hide-ending-next = Masqué à partir de la prochaine conversation
chrome-hide-ending-agentReached = Ajouté à votre passeport. Ce site, ouvert par l'agent, n'est pas retenu.
chrome-hide-ending-notHere = Ajouté à votre passeport, mais pas masqué sur cette page.
chrome-hide-ending-agentReached-known = Ce site, ouvert par l'agent, n'est pas retenu.
chrome-hide-ending-notHere-known = Pas masqué sur cette page.
chrome-hide-toast = Masqué pour l'agent
chrome-hide-toast-undo = Annuler
chrome-hide-toast-already = Déjà dans votre passeport.
chrome-hide-read-before = L'agent a peut-être déjà lu cette page.
chrome-hide-error-long = Ce texte est trop long pour le passeport.
chrome-hide-error-write = Le passeport n'a pas pu être enregistré.
chrome-hide-error-unreadable = Votre passeport est illisible : ouvrez Réglages › Passeport.
chrome-hide-error-full = Votre passeport est plein.
chrome-hide-error-invalid = Ce texte ne correspond pas à ce type : choisissez-en un autre.
chrome-hide-legend-text = Texte masqué : l'agent lit une étiquette à la place
chrome-hide-legend-field = Champ masqué : l'agent ne lit pas sa valeur en clair

## Suggestions du passeport sur un formulaire envoyé (chrome/passport/form-capture.ts)

chrome-passport-suggest = Ajouter à votre passeport ?
chrome-passport-suggest-value = { $kind } : { $value }
chrome-passport-suggest-remember = Retenir { $site }
chrome-passport-suggest-mute = Ne plus proposer
chrome-passport-suggest-mute-site = Sur ce site
chrome-passport-suggest-mute-all = Nulle part
chrome-passport-suggest-no = Non
chrome-passport-suggest-add = Ajouter
chrome-passport-suggest-close = Fermer
