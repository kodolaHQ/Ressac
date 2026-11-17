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
kernel-app-no-port = Plus de port libre : arrête une application.
kernel-app-not-responding = L'application ne répond pas sur le port { $port } après { $seconds } s.
kernel-app-exit-code = Arrêtée avec le code { $code }
kernel-app-exit-unknown = Arrêtée avec le code inconnu

kernel-ai-install-cancelled = Installation annulée
kernel-ai-install-running = Installation déjà en cours
kernel-ai-download-failed = Le téléchargement du modèle a échoué : { $error }
kernel-ai-hash-mismatch = Le modèle téléchargé est corrompu : il a été supprimé, relance le téléchargement.
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
kernel-err-internal-harvest = Mise à jour impossible : erreur interne du navigateur
kernel-err-no-workflow = Ce widget n'a ni workflow.json ni harvest.mjs
kernel-err-interrupted = Interrompue : Ressac s'est arrêté
kernel-err-grant-required = Accord requis pour lire avec ton compte : { $domains }
kernel-err-reads-required = Accord requis pour lire : { $domains }
kernel-err-reads-required-web = Accord requis pour lire : { $domains } et le web
kernel-err-reads-required-web-only = Accord requis pour chercher et lire le web
kernel-err-no-result = La récolte s'est arrêtée sans résultat (code { $code })
kernel-err-no-result-no-code = La récolte s'est arrêtée sans résultat
kernel-err-action-stopped = Arrêtée à ta demande
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
kernel-grant-action-changed = La déclaration de l'action { $id } a changé depuis l'affichage de la demande : rien n'est accordé, relis la nouvelle demande.
kernel-grant-widget-unknown = Widget inconnu : { $id }
kernel-grant-widget-unreadable = Widget illisible : { $error }
kernel-grant-widget-no-account = Le widget { $id } ne lit pas avec un compte
kernel-grant-widget-changed = La déclaration du widget { $id } a changé depuis l'affichage de la demande : rien n'est accordé, relis la nouvelle demande.
kernel-widget-invalid = widget.json invalide : { $error }

# Texts of the command runner (shown in install and workshop errors).
kernel-run-not-found = { $command } introuvable
kernel-run-cancelled = Annulé

# Erreurs montrées dans l'interface (action inconnue, saisie, rejeu, atelier).
kernel-err-action-unknown = Action inconnue
kernel-err-input-required = Saisie requise : { $label }
kernel-err-workshop-unavailable = Conteneur indisponible ({ $state })
kernel-err-custom-profile-browser = Le profil « { $name } » ne tourne qu'en mode Atelier : choisissez Atelier dans le panneau de l'agent.
kernel-replay-not-found = Rejeu impossible : exécution introuvable
kernel-replay-block-absent = Rejeu impossible : le bloc « { $id } » n'est pas dans le workflow
kernel-replay-output-missing = Rejeu impossible : la sortie de « { $id } » manque dans cette exécution
kernel-replay-output-truncated = Rejeu impossible : la sortie de « { $id } » a été tronquée dans cette exécution
kernel-replay-too-big = Rejeu impossible : les sorties à reprendre dépassent 4 Mo
kernel-network-failed = Le réseau de l'agent n'a pas pu être sécurisé : { $error }
kernel-network-open = l'accès direct n'est pas fermé (sonde : code { $code })

kernel-writer-none = Connectez Claude Code ou Codex dans Réglages › Agents pour les résumés
kernel-writer-workshop-stopped = L'atelier de l'agent n'est pas démarré : les résumés reprendront à son démarrage
kernel-writer-limit = Limite de votre abonnement atteinte : les résumés reprendront plus tard
kernel-writer-images = Les images ne sont pas prises en charge par la rédaction
kernel-writer-failed-badge = La rédaction par l'IA a échoué : voir le journal du widget
kernel-writer-failed = L'IA n'a pas pu rédiger : { $reason }
