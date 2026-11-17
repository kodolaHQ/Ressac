# Home, first-launch welcome, import, Extensions, Applications, permission cards.

home-cancel = Annuler
home-deny = Refuser
home-allow = Autoriser
home-close = Fermer
home-delete = Supprimer
home-quoted = « { $name } »
home-agent = l'agent
home-agent-cap = L'agent
home-by-agent = Écrite par l'agent

## Welcome

home-welcome-label = Bienvenue dans Ressac
home-welcome-tagline = Un navigateur calme, avec un agent quand vous le voulez.
home-welcome-start = Commencer
home-welcome-continue = Continuer
home-welcome-next = Suivant
home-welcome-resume = Reprendre l'accueil
home-welcome-back = Retour
home-welcome-later = Plus tard
home-welcome-yes = Oui
home-welcome-done = Terminer
home-welcome-ai-ask-title = Activer l'IA ?
home-welcome-ai-ask-intro = Un agent peut travailler pour vous : il navigue, cherche, compare, construit des applis et tient vos widgets à jour.
home-welcome-ai-ask-needs = Il lui faut OrbStack (ou Docker Desktop) et un compte Claude ou ChatGPT. Ressac télécharge aussi deux petits modèles d'IA locale (1,4 Go).
home-welcome-ai-ask-later = Sans l'IA, Ressac reste un navigateur, et rien ne tourne en arrière-plan. Vous pourrez l'activer plus tard dans Réglages › Agents.
home-welcome-checking = Vérification…
home-welcome-recheck = Vérifier à nouveau
home-welcome-import-title = Vous venez d'un autre navigateur ?
home-welcome-sidebar-title = Vos onglets vivent à gauche
home-welcome-sidebar-tabs = Les onglets de l'espace en cours, en liste.
home-welcome-sidebar-spaces = Les espaces en bas : un par sujet, chacun avec son aura.
home-welcome-sidebar-command = ouvre un onglet ou cherche partout.
home-welcome-engine-title = Quel moteur de recherche ?
home-welcome-engine-intro = Ce que vous tapez dans la barre, quand ce n'est pas une adresse, part vers ce moteur.
home-welcome-engine-group = Moteur de recherche
home-welcome-engine-later = Vous pourrez le changer dans Réglages › Vie privée.
home-welcome-appearance-title = Claire ou sombre ?
home-welcome-appearance-later = Vous pourrez la changer dans Réglages › Vie privée.
home-welcome-agent-title = Brancher un agent
home-welcome-agent-intro = Claude Code et Codex travaillent dans un conteneur à part, sur votre Mac. Il leur faut OrbStack (ou Docker Desktop).
home-welcome-docker-stopped = { $app } est installé mais arrêté.
home-welcome-docker-start = Démarrer { $app }
home-welcome-docker-absent = OrbStack n'est pas lancé ou pas installé.
home-welcome-docker-install = Installer OrbStack
home-welcome-docker-unreachable = Impossible de vérifier pour l'instant.
home-welcome-docker-ready = Docker est prêt.
home-welcome-agent-group = Agent
home-welcome-agent-login = Vous vous connecterez la première fois que vous ouvrirez l'agent ({ $key }).
home-welcome-ai-title = L'IA locale
home-welcome-ai-intro = Une petite IA tourne sur votre Mac, en plus de l'agent. Elle est gratuite et rien de ce qu'elle lit ne quitte votre machine. Elle sert à :
home-welcome-ai-guard = surveiller l'agent : elle le met en pause quand une de ses actions paraît étrange ;
home-welcome-ai-triage = trier pour vous : quand Ressac suit un sujet à votre place, elle choisit ce qui mérite de vous être montré ;
home-welcome-ai-search = retrouver vos pages par leur sens, quand vous posez une question avec ⌘T.
home-welcome-ai-needs = Elle utilise deux modèles que Ressac télécharge pour vous : d1-2B (1,1 Go) pour surveiller et trier, et EmbeddingGemma (334 Mo) pour la recherche.
home-welcome-models-started = Téléchargement en cours. Le suivi est dans Réglages › IA locale.
home-welcome-models-missing = { $missing ->
    [decision] Il manque le modèle d'IA locale d1-2B (1,1 Go).
    [search] Il manque le modèle de recherche EmbeddingGemma (334 Mo).
   *[both] Il manque les modèles d'IA locale (1,4 Go).
}
home-welcome-models-pull = Télécharger en arrière-plan
home-welcome-models-ready = Les modèles sont installés.
home-welcome-models-unreachable = Impossible de vérifier pour l'instant.
home-welcome-ready-title = C'est prêt
home-welcome-space-label = Votre premier espace
home-welcome-aura-group = Aura
home-welcome-aura-choice = Aura { $name }
home-welcome-notifications-note = Pour recevoir les alertes des sites et de la veille, autorisez les notifications de Ressac dans les Réglages Système.
home-welcome-notifications-open = Ouvrir les réglages de notifications
home-welcome-finish = Ouvrir le navigateur
home-welcome-page = Page { $page } sur { $total }

## Import from another browser

home-import-type-bookmarks = Favoris
home-import-type-history = Historique
home-import-type-passwords = Mots de passe
home-import-type-spaces = Espaces et onglets épinglés
home-import-type-tabs = Onglets ouverts
home-import-start-failed = L'import n'a pas pu démarrer : { $reason }
home-import-csv-result = { $count ->
    [one] { $count } mot de passe importé
   *[other] { $count } mots de passe importés
}
home-import-safari-1 = Ouvrez l'app Mots de passe.
home-import-safari-2 = Fichier › Exporter tous les mots de passe…
home-import-other-1 = Dans { $name }, ouvrez about:logins
home-import-other-2 = ⋯ › Exporter les identifiants
home-import-guide-choose = Choisissez le fichier ci-dessous.
home-import-guide-delete = Supprimez ensuite le fichier exporté : il n'est pas chiffré.
home-import-checking = Vérification…
home-import-none = Aucun autre navigateur trouvé sur ce Mac.
home-import-browser = Navigateur
home-import-profile = Profil
home-import-passwords = Mots de passe
home-import-csv-pick = Choisir le fichier CSV…
home-import-start = Importer
home-import-done = Import terminé.
home-import-started = Import lancé : une notification vous préviendra à la fin.
home-import-failed = { $type } : { $why }
home-import-disk-access = Ouvrir les réglages
home-import-access = macOS protège les données de { $name }. Cliquez sur « Autoriser l'accès », puis sur « Ouvrir » dans la fenêtre qui s'affiche : elle est déjà sur le bon dossier.
home-import-access-grant = Autoriser l'accès

## Release notes page

home-notes-title = Nouveautés

## Permission cards

home-request-label-devtools = Demande d'accès aux outils de développement
home-request-label-action = Demande d'accès aux résultats d'une action
home-request-label-site = Demande d'accès à une appli de site
home-request-label-history = Demande d'accès à ton historique
home-request-label-widget = Demande d'accès aux données d'un widget
home-request-label-extension = Activer une extension
home-request-label-console = Débloquer la console d'une extension
home-request-label-address = L'agent veut ouvrir une adresse qu'il a écrite lui-même
home-request-label = Demande d'autorisation
home-request-unreadable = Demande d'extension illisible.
home-request-console-where-profiles = des profils où elle est active
home-request-console-where-space = de l'espace « { $space } »
home-request-console-where-spaces = des espaces { $spaces }
home-request-console = L'agent demande à voir toute la console de « { $name } » pour la corriger. Il verra ce que l'extension écrit dans sa console sur tous les onglets { $where }, y compris ceux que vous ne partagez pas. Jusqu'à ce que vous le coupiez ou qu'il ait fini.
home-request-console-reason = Raison donnée par { $agent } : « { $reason } »
home-request-console-unlock = Débloquer
home-request-address-reason = Sa raison : { $reason }
home-request-address-opinion = Avis du surveillant : { $opinion }
home-request-why = Pourquoi on me demande ça ?
home-request-why-1 = L'agent ouvre librement les liens qu'il trouve dans les pages qu'il lit et dans ses résultats de recherche. Cette adresse, il ne l'a trouvée nulle part : il l'a écrite lui-même.
home-request-why-2 = Une page piégée peut lui souffler une adresse qui emporte des informations vers un site inconnu. Un coup d'œil à l'adresse et à sa raison suffit ; dans le doute, « Refuser » : l'agent continue autrement.
home-request-widget-action = L'agent veut voir les résultats de l'action « { $title } » (lus avec ton compte).
home-request-widget-site = L'agent veut voir l'appli de site « { $title } » (connectée à ton compte) : ses pages et sa mémoire, pour cette conversation.
home-request-history = L'agent veut chercher et lire dans ton historique et tes favoris, pour cette conversation.
home-request-widget = L'agent veut voir les données du widget « { $title } » (lues avec ton compte).
home-request-allow-conversation = Autoriser pour cette conversation
home-request-tab = L'agent veut lire l'onglet « { $title } »
home-request-allow-once = Autoriser une fois

home-devtools-title = { $agent } veut accéder aux outils de développement
home-devtools-site = { $site } · onglet « { $tab } »
home-devtools-console = Console et erreurs
home-devtools-console-detail = Messages, erreurs JavaScript, avertissements
home-devtools-network = Réseau
home-devtools-network-detail = Requêtes et réponses de la page
home-devtools-network-sensitive = peut contenir des données de connexion
home-devtools-performance = Performances et mémoire
home-devtools-performance-detail = Profilage, instantanés mémoire
home-devtools-act = Agir sur la page
home-devtools-act-detail = Exécuter du JavaScript, modifier le DOM, recharger
home-devtools-act-sensitive = l'agent peut agir en ton nom sur ce site
home-devtools-allow = Autoriser la sélection
home-devtools-note = Valable pour cette conversation · tombe si l'onglet change de site

home-ext-update = Mettre à jour
home-ext-update-end = { " ?" }
home-ext-activate = Activer
home-ext-activate-in = dans « { $space } » ?
home-ext-version = Version { $from } → { $to }
home-ext-wants = Ce qu'elle veut faire :
home-ext-all-sites = Sur tous les sites que vous visitez
home-ext-sites = Sur : { $sites }
home-ext-sites-more = { $list } et { $count } autres
home-ext-other-spaces = Elle sera active aussi dans { $names } (même profil).
home-ext-also-replaces = La nouvelle version remplacera aussi celle de { $names }.
home-ext-network-none = Elle ne peut rien envoyer vers internet.
home-ext-network = Elle pourra envoyer des données à : { $sites }.
home-ext-scripts = Ses scripts tournent dans les pages : ils pourraient faire charger une ressource à la page, et ainsi faire sortir des données. Les champs de mot de passe lui sont masqués, sans garantie absolue.
home-ext-agent-blind = L'agent ne voit pas ce que cette extension lit sur les onglets que vous ne lui avez pas partagés.
home-ext-hardened = Elle pourra lire et modifier chaque page de cet espace, comptes connectés compris.
home-ext-confirm = Je comprends : elle lira toutes les pages de cet espace
home-ext-enable = Activer
home-ext-tick-first = Coche « Je comprends » pour pouvoir l'activer.

## Extensions page

home-extensions-title = Extensions
home-extensions-cut-all = Désactiver toutes les extensions
home-extensions-help = Comment ça marche
home-extensions-step1 = Branchez votre compte Mozilla
home-extensions-step1-text = { " " }(une fois). Firefox n'installe que des extensions signées par Mozilla.
home-extensions-connected = Compte branché
home-extensions-connect = Brancher mon compte Mozilla
home-extensions-step2 = Demandez à l'agent
home-extensions-step2-text = { " : " }« écris-moi une extension qui… ». Il l'écrit, la fait signer (comptez quelques minutes), puis vous demande votre accord pour l'installer, avec ses droits et ses sites.
home-extensions-step3 = Gérez-la ici
home-extensions-step3-text = { " : " }l'activer par espace, voir ses erreurs, la faire modifier par l'agent, la supprimer.
home-extensions-help-note = La signature envoie le code de l'extension à Mozilla ; elle n'est pas publiée sur le catalogue public.
home-extensions-all-cut = Toutes les extensions sont désactivées : aucune n'est chargée, même après un redémarrage.
home-extensions-empty = Aucune extension. Demandez à l'agent d'en écrire une, ou installez-en depuis addons.mozilla.org.
home-extensions-disabled-crashes = Désactivée : elle a planté 3 fois en une minute
home-extensions-disabled-scope = Désactivée : elle demande plus de droits qu'accordé
home-extensions-console-unlocked = Console débloquée pour l'agent
home-extensions-pending-update = Mise à jour { $version } en attente de votre accord.
home-extensions-rights = Droits : { $list }
home-extensions-sites = Sites : { $list }
home-extensions-spaces = Espaces : { $list }
home-extensions-none = aucun
home-extensions-none-f = aucune
home-extensions-all-sites = tous les sites
home-extensions-nowhere = Active nulle part
home-extensions-space-item = « { $name } » (profil { $profile })
home-extensions-active-in = Active dans : { $names }
home-extensions-modified = Modifiée le { $date }
home-extensions-unsupported = Non pris en charge : { $list }
home-extensions-errors = Erreurs : { $list }
home-extensions-label-rights = Droits
home-extensions-label-sites = Sites
home-extensions-label-errors = Erreurs
home-extensions-key = Clé
home-extensions-review-update = Revoir la mise à jour
home-extensions-review-grant = Revoir l'accord
home-extensions-reenable = Réactiver
home-extensions-cut-unlock = Couper le déblocage
home-extensions-disable-everywhere = Désactiver partout
home-extensions-details = Détails
home-extensions-delete-store = Supprimer « { $name } » ? Elle sera désinstallée de tous les profils.
home-extensions-delete-agent = Supprimer « { $name } » ? Son accord et sa copie seront effacés ; le dossier de l'agent reste.

## Applications page

home-apps-title = Applications
home-apps-filters = Filtres
home-apps-group-type = Type
home-apps-group-state = État
home-apps-filter-all = Tout
home-apps-filter-app = Applications
home-apps-filter-poc = POC et tests
home-apps-filter-no-manifest = Sans fiche
home-apps-filter-running = En marche
home-apps-filter-stopped = Arrêtées
home-apps-filter-error = En erreur
home-apps-type-app = Application
home-apps-type-poc = POC
home-apps-type-no-manifest = Sans fiche
home-apps-state-stopped = Arrêtée
home-apps-state-preparing = Préparation de l'atelier…
home-apps-state-launching = Lancement…
home-apps-state-running = En marche
home-apps-state-error = En erreur
home-apps-today = aujourd'hui
home-apps-yesterday = hier
home-apps-days-ago = il y a { $days } j
home-apps-from = depuis { $origin }
home-apps-port = port { $port }
home-apps-search = Chercher une appli…
home-apps-no-docker = Docker n'est pas lancé. La liste reste visible, mais aucune appli ne peut être lancée.
home-apps-empty = Rien ici pour l'instant. Demande à l'agent de tester un package ou de construire une app.
home-apps-no-match = Aucune appli ne correspond.
home-apps-more = Plus d'actions
home-apps-debug = Déboguer
home-apps-stop = Arrêter
home-apps-changes = Modifications
home-apps-open = Ouvrir
home-apps-relaunch = Relancer
home-apps-launch = Lancer
home-apps-promote = Passer en application
home-apps-folder = Afficher le dossier
home-apps-sites = Sites
home-apps-site-open = Ouverte
home-apps-site-closed = Fermée
home-apps-site-edit = Modifier avec l'agent
home-apps-site-forget = Oublier ce que l'appli a retenu
home-apps-forget-confirm = Oublier tout ce que « { $name } » a retenu (séries, positions des vidéos) ?
home-apps-forget = Oublier
home-apps-site-delete-confirm = Supprimer « { $name } » ? Sa connexion et sa mémoire sont effacées, son dossier va à la corbeille.
home-apps-delete-confirm = Supprimer « { $name } » ? Son dossier sera effacé.

## External projects

home-external-title = Projets externes
home-external-ports = Ports { $ports }
home-external-no-client = aucun client
home-external-review = Modifications
home-external-forget = Oublier
home-external-connected-on = Branché le { $date }
home-external-revoke = Révoquer
home-external-none = Aucun Claude Code branché.
home-external-command = Colle cette commande dans un terminal : elle ne sera plus affichée.
home-external-copied = Copié
home-external-copy = Copier
home-external-client-name = Nom du client
home-external-confirm = Brancher
home-external-connect = Brancher un Claude Code
home-external-failed = Le branchement a échoué.

## Home page

home-empty = Aucun widget pour l'instant. Demande à l'agent de créer le premier.
home-no-effect = Sans effet pour l'instant : le service des widgets ne répond pas (agent arrêté ?).
home-grant-not-saved = Accord non enregistré : { $error }
home-remove-confirm = Retirer « { $name } » de la page d'accueil ?
home-remove = Retirer
home-widget-unreadable = Widget « { $id } » illisible : { $error }
home-widget-progress = mise à jour… { $done } / { $total }
home-widget-updating = mise à jour…
home-widget-failed = échec du { $date } : { $error }
home-widget-unknown-error = erreur inconnue
home-widget-unknown-date = date inconnue
home-widget-workshop-stopped = mise à jour impossible : atelier arrêté
home-widget-next = prochaine : { $next }
home-widget-options = Options du widget
home-widget-update-now = Mettre à jour maintenant
home-widget-workflow = Voir / modifier le workflow
home-widget-grant-public = Ce widget veut lire { $account } avec ton compte, et pourra contacter : { $public }.
home-widget-grant-private = Ce widget veut lire { $account } avec ton compte, et ne contactera aucun autre site.
home-widget-allow = Autoriser…
home-widget-reads-public = Ce widget lira : { $public }
home-widget-reads-web = Ce widget cherche et lit le web
home-widget-reads-public-web = Ce widget lira : { $public }, et cherche et lit le web
home-widget-reads-allow = Autoriser
home-widget-resize = Redimensionner
home-widget-no-display = L'agent n'a pas encore écrit l'affichage de ce widget.

## Profile labels (grant cards, Réglages › Permissions)

home-profile-of = Profil de « { $spaces } »
home-profile = Profil « { $id } »
