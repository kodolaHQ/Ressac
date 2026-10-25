# Résultats du test de connexion Google

*Testé par l'utilisateur le 25 octobre 2026.* Electron : 45.0.0 (Chromium 156)

Lancer depuis la racine du projet :
- mode défaut : `corepack pnpm --filter connexion-google start -- --url https://accounts.google.com`
- mode chrome : `SPIKE_UA=chrome corepack pnpm --filter connexion-google start -- --url https://accounts.google.com`

Raccourcis : ⌘0 Google · ⌘1 Gmail · ⌘2 YouTube · ⌘3 daily.dev · ⌘[ retour.
Les deux modes partagent la même session : faire le mode défaut d'abord, puis supprimer
`~/Library/Application Support/connexion-google/Partitions/spike` avant le mode chrome.

| Essai | Mode défaut | Mode chrome |
|---|---|---|
| (a) Connexion au compte Google | ✅ (mot de passe ; passkey impossible) | |
| (b) Gmail s'ouvre connecté | ✅ | |
| (c) YouTube connecté + lecture d'une vidéo | ✅ | |
| (d) daily.dev « Se connecter avec Google » | ✅ au 2ᵉ essai (1ᵉʳ essai : l'app s'est fermée, non reproduit) | |
| (e) Toujours connecté après redémarrage | ✅ | |

Messages d'erreur exacts :

- Mode défaut : la connexion par **passkey** (clé d'accès) ne se lance pas. Electron ne prend pas en charge, à notre connaissance, les passkeys du Mac (Touch ID, trousseau iCloud).

**Conclusion : Electron retenu.** Tout passe en mode défaut ; le mode chrome n'a pas été nécessaire.

Réserves pour la suite :
- **Passkeys** : pas prises en charge (Touch ID / trousseau iCloud). Il faut passer par le mot de passe
  et la double authentification. À traiter avec le remplissage des mots de passe (hors V1).
- **Fermeture inexpliquée** de l'app lors d'un 1ᵉʳ essai de connexion Google sur daily.dev, non reproduite.
  Le journal `[diag]` de `main.mjs` est conservé ; à surveiller dans le vrai navigateur (plan 2).

Notes :
- 1ᵉʳ essai daily.dev : l'app s'est arrêtée (code 0, donc toutes les fenêtres fermées, sans plantage
  du rendu). Avec le journal de diagnostic, le 2ᵉ essai passe par la popup
  `about:blank → daily.dev/callback?login=true` sans problème. Cause non identifiée.
