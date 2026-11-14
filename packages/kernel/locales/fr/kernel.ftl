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
kernel-ai-install-uv = installe uv : brew install uv
kernel-ai-git-clone-failed = git clone a échoué : { $error }
kernel-ai-commit-mismatch = Le commit de Kev n'est pas celui attendu ({ $expected }) : { $found }
kernel-ai-uv-sync-failed = uv sync a échoué : { $error }
kernel-ai-pull-failed = ollama pull a échoué : { $error }
