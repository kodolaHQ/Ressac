# Textes que le noyau montre à l'utilisateur : notifications de veille, étapes de l'atelier, applications, installation de l'IA locale.

kernel-new-items = { $n ->
    [one] { $n } nouvel élément
   *[other] { $n } nouveaux éléments
}

kernel-build-base-image = Téléchargement de l'image de base
kernel-build-system-tools = Outils système
kernel-build-claude-codex = Installation de Claude Code et Codex
kernel-build-preparing = Préparation
kernel-container-start-failed = Démarrage du conteneur { $name } impossible : { $error }

kernel-app-docker-not-running = Docker n'est pas lancé.
kernel-app-no-port = Plus de port libre : arrêtez une application.
kernel-app-not-responding = L'application ne répond pas sur le port { $port } après { $seconds } s.
kernel-app-exit-code = Arrêtée avec le code { $code }
kernel-app-exit-unknown = Arrêtée avec le code inconnu

kernel-ai-install-cancelled = Installation annulée
kernel-ai-install-running = Installation déjà en cours
kernel-ai-download-failed = Le téléchargement du modèle a échoué : { $error }
kernel-ai-hash-mismatch = Le modèle téléchargé est corrompu : il a été supprimé, relancez le téléchargement.
kernel-ai-llama-server-missing = llama-server introuvable
kernel-ai-not-installed = IA locale non installée
kernel-ai-llama-unreachable = llama-server ne répond pas : { $error }
kernel-ai-llama-status = llama-server a répondu { $status }
kernel-ai-llama-start-failed = llama-server n'a pas démarré : { $detail }
kernel-ai-llama-start-timeout = llama-server n'a pas démarré : délai dépassé. { $detail }

# Erreurs que le noyau écrit dans les exécutions des widgets et des actions (montrées sur les cartes). Les textes gardés restent dans leur langue.
kernel-err-timeout = Délai dépassé
kernel-err-response-too-big = Réponse trop grande
kernel-err-profile-denied = Le profil de connexion choisi n'est plus utilisable (supprimé ou utilisé par un espace privé) : accord à redonner
kernel-err-workshop-stopped = Mise à jour impossible : atelier arrêté
kernel-widget-lab-required = Ce widget a du code écrit par l'agent ou suit le web (veille) : il demande le labo.
kernel-err-internal-harvest = Mise à jour impossible : erreur interne du navigateur
kernel-err-no-workflow = Ce widget n'a ni workflow.json ni harvest.mjs
kernel-err-interrupted = Interrompue : Ressac s'est arrêté
kernel-err-grant-required = Accord requis pour lire avec votre compte : { $domains }
kernel-err-reads-required = Accord requis pour lire : { $domains }
kernel-err-reads-required-web = Accord requis pour lire : { $domains } et le web
kernel-err-reads-required-web-only = Accord requis pour chercher et lire le web
kernel-err-code-changed = Le code a changé depuis votre accord
kernel-err-no-result = La récolte s'est arrêtée sans résultat (code { $code })
kernel-err-no-result-no-code = La récolte s'est arrêtée sans résultat
kernel-err-action-stopped = Arrêtée à votre demande
kernel-err-action-internal = Action impossible : erreur interne du navigateur
kernel-err-action-no-workflow = Cette action n'a pas de workflow.json
kernel-err-result-too-big = Résultats trop gros pour être gardés
kernel-err-cannot-launch = Récolte impossible à lancer : { $error }
kernel-harvest-folder-refused = Le dossier du widget ou de l'action est un lien, ou a disparu
kernel-harvest-file-too-big = { $name } est trop gros pour la récolte (1 Mo par fichier, 4 Mo en tout)
kernel-err-data-too-big = Données trop grosses (2 Mo au plus)
kernel-memory-not-kept = Mémoire des blocs non gardée : plus de 3 Mo (l'ancienne reste)
kernel-log-lines-cut = … { $n } lignes coupées

# Erreurs de la carte d'accord (affichées dessous).
kernel-grant-action-unknown = Action inconnue : { $id }
kernel-grant-action-unreadable = Action illisible : { $error }
kernel-grant-action-no-account = L'action { $id } ne lit pas avec un compte
kernel-grant-action-changed = La déclaration de l'action { $id } a changé depuis l'affichage de la demande : rien n'est accordé, relisez la nouvelle demande.
kernel-grant-widget-unknown = Widget inconnu : { $id }
kernel-grant-widget-unreadable = Widget illisible : { $error }
kernel-grant-widget-no-account = Le widget { $id } ne lit pas avec un compte
kernel-grant-widget-changed = La déclaration du widget { $id } a changé depuis l'affichage de la demande : rien n'est accordé, relisez la nouvelle demande.
kernel-widget-invalid = widget.json invalide : { $error }

# Texts of the command runner (shown in install and workshop errors).
kernel-run-not-found = { $command } introuvable
kernel-run-cancelled = Annulé

# Erreurs montrées dans l'interface (action inconnue, saisie, rejeu, atelier).
kernel-err-action-unknown = Action inconnue
kernel-err-input-required = Saisie requise : { $label }
kernel-err-workshop-unavailable = Conteneur indisponible ({ $state })
kernel-err-machine-stopped = La machine de l'atelier n'est pas démarrée : réessayez, ou voyez pourquoi dans Réglages › Atelier.
kernel-err-lab-off = Cette fonction fait partie du labo, éteint : Réglages › Agent › Niveau d'usage.
kernel-mcp-lab-off = Cet outil fait partie du labo, que l'utilisateur a éteint : n'insiste pas, dis-lui ce qu'il faudrait activer.
kernel-workshop-no-engine = L'atelier n'a pas de moteur : ni sa machine ni Docker ne sont disponibles.
kernel-workshop-path-unmountable = Ce chemin ne peut pas être monté dans l'atelier : { $path }
kernel-workshop-not-folder = { $path } n'est pas un vrai dossier (un lien, par exemple) : remplacez-le par un dossier.
kernel-err-custom-profile-browser = Le profil « { $name } » ne tourne qu'en mode Atelier : choisissez Atelier dans le panneau de l'agent.
kernel-err-shape-locked = Le mode a changé pendant le verrou : levez d'abord le verrou pour ouvrir une conversation.
kernel-err-instructions-changed = Les consignes de l'agent ont changé depuis la dernière session : rouvrez le panneau pour les relire.
kernel-err-instructions-io = Impossible de lire ou de remettre les consignes de l'agent : { $error }
kernel-replay-not-found = Rejeu impossible : exécution introuvable
kernel-replay-block-absent = Rejeu impossible : le bloc « { $id } » n'est pas dans le workflow
kernel-replay-output-missing = Rejeu impossible : la sortie de « { $id } » manque dans cette exécution
kernel-replay-output-truncated = Rejeu impossible : la sortie de « { $id } » a été tronquée dans cette exécution
kernel-replay-too-big = Rejeu impossible : les sorties à reprendre dépassent 4 Mo
kernel-network-failed = Le réseau de l'agent n'a pas pu être sécurisé : { $error }
kernel-network-open = l'accès direct n'est pas fermé (sonde : code { $code })

kernel-writer-none = Connectez Claude Code ou Codex dans Réglages › Agent pour les résumés
kernel-writer-workshop-stopped = L'atelier de l'agent n'est pas démarré : les résumés reprendront à son démarrage
kernel-writer-limit = Limite de votre abonnement atteinte : les résumés reprendront plus tard
kernel-writer-limit-api = Limite d'usage de votre clé d'API ou de votre Ollama atteinte : les résumés reprendront plus tard
kernel-writer-images = Les images ne sont pas prises en charge par la rédaction
kernel-writer-failed-badge = La rédaction par l'IA a échoué : voir le journal du widget
kernel-writer-failed = L'IA n'a pas pu rédiger : { $reason }
kernel-writer-key-refused = clé refusée
kernel-sort-invalid = Le modèle n'a pas rendu une note par élément.

# Masquage : comment une carte nomme une valeur masquée sans la montrer (vos sources, puis le reste du web).
kernel-mask-name-code = votre code
    .genre = m
    .de = de votre code
kernel-mask-name-iban = votre IBAN
    .genre = m
    .de = de votre IBAN
kernel-mask-name-carte = votre carte
    .genre = f
    .de = de votre carte
kernel-mask-name-tel = votre téléphone
    .genre = m
    .de = de votre téléphone
kernel-mask-name-email = votre e-mail
    .genre = m
    .de = de votre e-mail
kernel-mask-name-adresse = votre adresse
    .genre = f
    .de = de votre adresse
kernel-mask-name-nom = votre nom
    .genre = m
    .de = de votre nom
kernel-mask-name-id = votre identifiant
    .genre = m
    .de = de votre identifiant
kernel-mask-name-secu = votre numéro de sécu
    .genre = m
    .de = de votre numéro de sécu
kernel-mask-name-motdepasse = votre mot de passe
    .genre = m
    .de = de votre mot de passe
kernel-mask-name-masque = votre valeur masquée
    .genre = f
    .de = de votre valeur masquée
kernel-mask-name-date = votre date
    .genre = f
    .de = de votre date
kernel-mask-name-web-code = un code
    .genre = m
    .de = d'un code
kernel-mask-name-web-iban = un IBAN
    .genre = m
    .de = d'un IBAN
kernel-mask-name-web-carte = un numéro de carte
    .genre = m
    .de = d'un numéro de carte
kernel-mask-name-web-tel = un téléphone
    .genre = m
    .de = d'un téléphone
kernel-mask-name-web-email = un e-mail
    .genre = m
    .de = d'un e-mail
kernel-mask-name-web-adresse = une adresse
    .genre = f
    .de = d'une adresse
kernel-mask-name-web-nom = un nom
    .genre = m
    .de = d'un nom
kernel-mask-name-web-id = un identifiant
    .genre = m
    .de = d'un identifiant
kernel-mask-name-web-secu = un numéro de sécu
    .genre = m
    .de = d'un numéro de sécu
kernel-mask-name-web-motdepasse = un mot de passe
    .genre = m
    .de = d'un mot de passe
kernel-mask-name-web-masque = une valeur masquée
    .genre = f
    .de = d'une valeur masquée
kernel-mask-name-web-date = une date
    .genre = f
    .de = d'une date

# Masquage : révélation d'une valeur et verrou de la conversation.
kernel-mask-reveal-card = L'agent veut voir { $name } pour cette tâche. Ensuite la conversation et l'atelier restent verrouillés jusqu'à ce que vous leviez le verrou.
kernel-mask-reveal-shared = Une autre conversation utilise l'atelier : l'agent ne peut pas voir { $name } tant qu'elle tourne.
kernel-mask-locked-danger = Conversation verrouillée : { $name } { $agreement ->
        [one-f] a été révélée
        [other-m] ont été révélés
        [other-f] ont été révélées
       *[one-m] a été révélé
    }. Cette sortie demande votre accord.
kernel-mask-locked-refused = Conversation verrouillée : cette sortie n'a pas reçu votre accord.
kernel-mask-handle-danger = Cette adresse contient { $name }, { $agreement ->
        [one-f] lue
        [other-m] lus
        [other-f] lues
       *[one-m] lu
    } sur { $from } : elle { $agreement ->
        [other-m] les envoie
        [other-f] les envoie
       *[one-m] l'envoie
    } à { $to }.
kernel-mask-label-alert = L'agent envoie { $agreement ->
        [other-m] les étiquettes { $de } (sans les valeurs)
        [other-f] les étiquettes { $de } (sans les valeurs)
       *[one-m] l'étiquette { $de } (sans la valeur)
    } vers { $destination }.
kernel-mask-destination-engine = votre moteur de recherche
kernel-mask-destination-page = la page de l'onglet { $id }
kernel-mask-unknown-label = Étiquette d'une conversation précédente ou inconnue : relis la page.
kernel-mask-fill-blocked = Remplissage bloqué pour cette conversation : trop d'étiquettes inconnues. Une nouvelle conversation le débloque.
kernel-mask-no-login = Aucun identifiant enregistré pour ce site : rien n'a été rempli.
kernel-mask-fill-changed = Le champ a changé avant le remplissage : rien n'a été écrit. Redemande.
kernel-mask-fill-action-danger = Ce formulaire envoie vers { $to }, pas vers le site du champ.
kernel-mask-fill-foreign-danger = Cette page, ouverte par l'agent, est sur { $to } : { $name } a été { $agreement ->
        [one-f] lue
       *[one-m] lu
    } sur { $from }.
kernel-mask-fill-foreign-passport = Cette page, ouverte par l'agent, est sur { $to }, pas sur un des sites prévus pour { $name } dans votre passeport ({ $from }).
kernel-mask-fill-foreign-danger-user = Cette page est sur { $to }, et { $name } a été { $agreement ->
        [one-f] lue
       *[one-m] lu
    } sur { $from } : vérifiez que c'est bien le site attendu.
kernel-mask-fill-foreign-passport-user = Cette page est sur { $to }, pas sur un des sites prévus pour { $name } dans votre passeport ({ $from }).
kernel-mask-fill-framed = Ce champ est dans un cadre de { $frame }, intégré à la page de { $top }.
kernel-mask-fill-check = cocher
kernel-mask-fill-uncheck = décocher
kernel-mask-fill-option = choisir « { $option } »
kernel-mask-fill-choice-acts = Sur votre onglet, cocher ou choisir peut agir tout de suite : un réglage enregistré, voire le formulaire envoyé.
kernel-mask-fill-choice-acts-agent = Sur cet onglet de l'agent, un compte où vous vous êtes connecté peut rester ouvert : cocher ou choisir peut agir tout de suite, un réglage enregistré, voire le formulaire envoyé.
kernel-mask-name-fill-text = un texte de l'agent
kernel-mask-fill-login-pair = votre identifiant et votre mot de passe
kernel-mask-capture-refused = Capture refusée : cet onglet montre vos données.
kernel-mask-devtools-card = Les outils de développement verraient vos données en clair.
kernel-mask-store-locked = L'atelier est verrouillé depuis une révélation : rien ne s'écrit dans ce qui survit à la conversation tant que vous n'avez pas levé le verrou.
kernel-mask-apps-locked = L'atelier est verrouillé depuis une révélation : aucune application ne se lance tant que vous n'avez pas levé le verrou.
kernel-mask-reveal-cut-failed = L'atelier n'a pas pu être verrouillé : l'agent ne peut pas voir { $name }.
kernel-mask-run-paused = En pause : son code a changé depuis une révélation, il reprendra quand vous lèverez le verrou de l'atelier.
kernel-err-code-refused = Lancement refusé à la vérification de son code : rien n'a tourné.
kernel-mask-design-locked = L'atelier de Ressac est verrouillé depuis une révélation : le MCP externe répondra quand l'utilisateur aura levé le verrou.
kernel-mask-lift-session = Arrêtez la conversation pour lever le verrou
kernel-mask-lift-move-failed = Le verrou reste : { $path } n'a pas pu être déplacé ({ $error }).
kernel-mask-lift-workshop = Le verrou reste : l'atelier ne répond pas ({ $state }).
kernel-mask-lift-busy = Le verrou est déjà en train d'être levé.
kernel-mask-restore-busy = Arrêtez la conversation et les applis de l'agent pour rendre ce fichier.
# Masquage : « de » devant un nom qui n'est pas une valeur connue.
kernel-mask-de = de { $name }

# Passeport : comment une carte nomme une donnée du passeport, par champ puis par sorte (design § 9.5).
kernel-mask-passport-name-nom = votre nom
kernel-mask-passport-name-naissance = votre date de naissance
kernel-mask-passport-name-proche = le nom d'un proche
kernel-mask-passport-name-adresse = votre adresse
kernel-mask-passport-name-tel = votre téléphone
kernel-mask-passport-name-email = votre e-mail
kernel-mask-passport-name-iban = votre IBAN
kernel-mask-passport-name-piece = votre numéro de pièce d'identité
kernel-mask-passport-name-secu = votre numéro de sécu
kernel-mask-passport-name-plaque = votre plaque d'immatriculation
kernel-mask-passport-name-libre = une donnée de votre passeport
kernel-mask-passport-name-prenoms = votre prénom
kernel-mask-passport-name-nom_famille = votre nom de famille
kernel-mask-passport-name-nom_complet = votre nom
kernel-mask-passport-name-adresse_voie = votre rue
kernel-mask-passport-name-code_postal = votre code postal
kernel-mask-passport-name-ville = votre ville
