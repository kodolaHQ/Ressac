# Réglages (agents, données, permissions, raccourcis, compte Mozilla), panneau de l'agent, relecture, mode design.

## Moteur d'un agent (Réglages › Agents)

agent-engine-title = Moteur de { $name }
agent-engine-kind-subscription = Abonnement Claude
agent-engine-kind-chatgpt = Abonnement ChatGPT
agent-engine-kind-api = API compatible
agent-engine-kind-api-openai = API compatible OpenAI
agent-engine-claude-ollama-note = Claude Code envoie de très longues consignes : prenez un grand modèle avec une grande fenêtre de contexte.
agent-engine-ollama-url = Adresse (vue depuis le conteneur)
agent-engine-model = Modèle
agent-engine-url = Adresse
agent-engine-api-placeholder-claude = https://api.exemple.com (sans /v1)
agent-engine-api-format-claude = L'API doit accepter le format de l'API Claude (/v1/messages).
agent-engine-api-format-codex = L'API doit accepter le format Responses d'OpenAI (/responses).
agent-engine-key = Clé
agent-engine-key-saved = clé enregistrée
agent-engine-key-delete = Effacer la clé
agent-engine-key-save = Enregistrer la clé
agent-engine-api-note = { $format } La clé reste dans le Trousseau de votre Mac : { $agent } ne la voit jamais.
agent-engine-next-chat = S'applique à la prochaine conversation avec { $name }.
agent-engine-url-invalid = Adresse invalide
agent-engine-url-invalid-https = Adresse invalide (https://…)
agent-engine-model-invalid = Modèle invalide
agent-engine-custom-too-long = Adresse trop longue
agent-engine-custom-https = L'adresse doit commencer par https://
agent-engine-custom-missing-s = Il manque %s à la place des mots cherchés

## Sélecteur de modèle Ollama

agent-ollama-none = Aucun modèle installé dans Ollama.
agent-ollama-choose = Choisir un modèle
agent-ollama-missing = { $name } (non installé)
agent-ollama-refresh = Actualiser
agent-ollama-silent = Ollama ne répond pas à cette adresse.

## Réglages › Données

agent-data-folder = Dossier
agent-data-reveal = Afficher dans le Finder
agent-data-notes = Carnet de recherche
agent-data-notes-help = Les leçons que l'agent tire de ses recherches : vous pouvez le lire et le corriger.
agent-data-import-title = Importer
agent-data-import = Importer depuis un autre navigateur
agent-data-backups = Sauvegardes
agent-data-delete = Supprimer
agent-data-delete-label = Supprimer la sauvegarde
agent-data-delete-confirm = Supprimer définitivement cette sauvegarde ?
agent-data-none = Aucune sauvegarde.
agent-data-export = Exporter
agent-data-exported = Exporté dans { $path }
agent-data-reset = Réinitialiser
agent-data-reset-confirm = Réinitialiser Ressac ? Ses données (espaces, onglets, historique, réglages, données des widgets et des actions, installation de Kev (IA locale, à réinstaller)) sont mises de côté dans une sauvegarde, puis Ressac redémarre à neuf. Restent en place : le dossier workspace (vos projets et ce que l'agent a créé), les connexions de Claude et de Codex (boutons Se déconnecter, section Agents), la clé de l'API compatible de Codex (Trousseau macOS), les cookies et mots de passe du navigateur (Réglages avancés du navigateur).
agent-data-reset-go = Réinitialiser et redémarrer
agent-data-reset-cancelled = Redémarrage annulé : rien n'a été réinitialisé.
agent-cancel = Annuler
agent-size-gb = { $n } Go
agent-size-mb = { $n } Mo

## Réglages › Permissions

agent-grants-revoke = Retirer
agent-grants-confirm = Les données lues avec ce compte sont effacées.
agent-grants-none = Aucun accès accordé.
agent-grants-ephemeral = Les accès éphémères aux onglets ne sont pas listés.
agent-grants-external = Projets externes du mode design
agent-grants-allowed = autorisé
agent-grants-denied = refusé
agent-grants-site-permission = { $label } : { $decision }
agent-permission-notifications = Notifications
agent-permission-geolocation = Position
agent-permission-media-camera = Caméra
agent-permission-media-micro = Micro
agent-permission-midi = MIDI
agent-permission-drm = Contenu protégé
agent-screen-title = Partage d'écran
agent-screen-broken = Le partage d'écran ne marche plus
agent-screen-help = Après une mise à jour, macOS peut bloquer le partage alors qu'il paraît autorisé. Réparer lui fait redemander l'autorisation.
agent-screen-repaired = Quittez puis rouvrez Ressac. Au prochain partage, macOS redemandera l'autorisation.
agent-screen-failed = La réparation a échoué. Dans Réglages Système › Confidentialité et sécurité › Enregistrement de l'écran, retirez Ressac puis relancez-le.
agent-screen-done = Réparé
agent-screen-repair = Réparer

## Réglages › Raccourcis

agent-shortcuts-vim = Mode vim
agent-shortcuts-vim-help = Des touches à la vim pour se déplacer dans les pages web.
agent-shortcuts-prompt = Appuyez sur la nouvelle combinaison…
agent-shortcuts-reset = Rétablir
agent-shortcuts-edit = Modifier
agent-shortcuts-reset-all = Tout rétablir
agent-shortcuts-fixed-tab = Onglet 1 à 9
agent-shortcuts-fixed-space = Espace 1 à 9
agent-shortcuts-fixed-recent = Onglets récents

## Réglages › Compte Mozilla

agent-mozilla-title = Compte Mozilla (extensions de l'agent)
agent-mozilla-help = Firefox n'installe que des extensions signées par Mozilla. Ressac les fait signer avec votre compte développeur Mozilla (gratuit).
agent-mozilla-on = Compte branché
agent-mozilla-off = Non branché
agent-mozilla-remove = Retirer
agent-mozilla-link = Ouvrir la page des clés Mozilla
agent-mozilla-steps = Connectez-vous ou créez un compte, acceptez l'accord développeur, puis générez des identifiants.
agent-mozilla-issuer = Émetteur JWT
agent-mozilla-secret = Secret JWT
agent-mozilla-save = Enregistrer

## Réglages › Vie privée

agent-telemetry-notice = Ressac envoie à son développeur les plantages et les erreurs, sans adresse de page, pour corriger les bugs de la bêta, et à chaque lancement un identifiant d'installation anonyme pour compter les utilisateurs. Un plantage peut contenir des fragments de mémoire.

## Panneau de l'agent

agent-panel-handle = Largeur du panneau agent
agent-panel-label = Agent
agent-panel-signed-out = { $name } (non connecté)
agent-panel-codex-signed-out = Codex n'est pas connecté à votre compte ChatGPT.
agent-panel-login = Se connecter
agent-panel-preparing = Préparation de l'agent… (la première fois, la construction du conteneur prend quelques minutes)
agent-panel-build-step =
    Préparation de l'agent, étape { $step }/{ $of } : { $label }… ({ $minutes ->
        [0] moins d'une
       *[other] { $minutes }
    } min) (la première fois, la construction du conteneur prend quelques minutes)
agent-panel-docker-absent = Docker n'est pas lancé. La navigation fonctionne ; seul l'agent est indisponible.
agent-panel-error = L'agent n'a pas pu démarrer : { $message }
agent-panel-done = L'agent s'est arrêté.
agent-panel-retry = Réessayer
agent-panel-restart = Relancer

## Relecture

agent-review-label = Relecture
agent-review-send = Envoyer { $count ->
    [one] { $count } commentaire
   *[other] { $count } commentaires
} à { $destination }
agent-review-nobody = personne
agent-review-mark-read = Marquer comme relu
agent-review-refresh = Rafraîchir
agent-review-unavailable = Relecture indisponible : { $reason }
agent-review-open-failed = la relecture n'a pas pu être ouverte
agent-review-files = Fichiers modifiés
agent-review-empty = Rien n'a changé depuis la dernière relecture.
agent-review-comments = Commentaires
agent-review-gone = Ce fichier n'est plus dans cette comparaison : Rafraîchis la relecture.
agent-review-status-added = ajouté
agent-review-status-deleted = supprimé
agent-review-status-modified = modifié

## Fichier comparé et commentaires

agent-diff-label = Diff de { $path }
agent-diff-binary = fichier binaire
agent-diff-too-big = fichier trop gros pour la relecture
agent-diff-no-lines = Aucune ligne modifiée.
agent-diff-expand = Afficher les lignes cachées
agent-diff-range-outside = Un commentaire porte sur des lignes d'un seul bloc du diff.
agent-diff-comment-line = Commenter la ligne { $line }
agent-diff-comment-title = Commenter (Maj+clic ou glisser : plusieurs lignes)
agent-diff-comment-placeholder = Commentaire (texte simple, Markdown montré tel quel)
agent-diff-comment-submit = Commenter
agent-diff-comment-failed = Le commentaire n'a pas pu être enregistré.
agent-comment-line = Ligne { $line }
agent-comment-lines = Lignes { $start }–{ $end }
agent-comment-sent = envoyé
agent-comment-resolved = résolu
agent-comment-line-changed = la ligne a changé
agent-comment-text = Texte du commentaire
agent-comment-save = Enregistrer
agent-comment-edit = Modifier
agent-comment-reopen = Rouvrir
agent-comment-resolve = Résoudre
agent-comment-delete = Supprimer

## Mode design : panier et bulle

agent-basket-label = Panier du mode design
agent-basket-title = Panier
agent-basket-close = Fermer le panier
agent-basket-empty = Aucune remarque. Clique un élément de la page pour en écrire une.
agent-basket-delete = Supprimer
agent-basket-sent-label = Lots envoyés
agent-basket-sent = Envoyés
agent-basket-state-pending = en attente
agent-basket-state-read = lu
agent-basket-state-handled = traité
agent-basket-destination-agent = agent
agent-basket-handled = Traité
agent-basket-send = Envoyer { $count ->
    [one] { $count } remarque
   *[other] { $count } remarques
} à { $destination }
agent-bubble-label = Remarque sur l'élément
agent-bubble-placeholder = Ta remarque sur cet élément
agent-bubble-add = Ajouter au panier

## Réglages › Raccourcis : touches vim (ids by position in shared/vim-keys.ts, kept in step by test/agent-vim-i18n.test.ts)

agent-vim-0-title = Défiler
agent-vim-0-0 = Une ligne vers le bas / le haut
agent-vim-0-1 = À gauche / à droite
agent-vim-0-2 = Une demi-page vers le bas / le haut
agent-vim-0-3 = Haut / bas de la page
agent-vim-1-title = Naviguer
agent-vim-1-0 = Page précédente / suivante
agent-vim-1-1 = Recharger
agent-vim-1-2 = Barre d'adresse
agent-vim-1-3 = Copier l'adresse de la page
agent-vim-2-title = Onglets et espaces
agent-vim-2-0 = Onglet précédent / suivant, en boucle
agent-vim-2-1 = Onglet précédent / suivant, en boucle
agent-vim-2-2 = Premier / dernier onglet de l'espace
agent-vim-2-3 = Nouvel onglet (barre de commande)
agent-vim-2-4 = Fermer l'onglet
agent-vim-2-5 = Rouvrir l'onglet fermé
agent-vim-2-6 = Espace suivant / précédent, en boucle
agent-vim-3-title = Liens et recherche
agent-vim-3-0 = Des lettres sur les liens visibles : tapez-les pour ouvrir le lien
agent-vim-3-1 = Pareil, dans un nouvel onglet
agent-vim-3-2 = Rechercher dans la page
agent-vim-4-title = Pause
agent-vim-4-0 = Mettre les touches vim en pause dans cet onglet : tout va à la page
agent-vim-4-1 = Reprendre (ou mettre en pause)
agent-vim-4-2 = Quitter les lettres ou un préfixe en cours
agent-vim-4-3 = Afficher cette aide
agent-vim-key-escape = Échap
