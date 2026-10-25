# Résultats du test de connexion Google

*À remplir par l'utilisateur.* Electron : 45.0.0

Lancer depuis la racine du projet :
- mode défaut : `corepack pnpm --filter connexion-google start -- --url https://accounts.google.com`
- mode chrome : `SPIKE_UA=chrome corepack pnpm --filter connexion-google start -- --url https://accounts.google.com`

Raccourcis : ⌘0 Google · ⌘1 Gmail · ⌘2 YouTube · ⌘3 daily.dev · ⌘[ retour.
Les deux modes partagent la même session : faire le mode défaut d'abord, puis supprimer
`~/Library/Application Support/connexion-google/Partitions/spike` avant le mode chrome.

| Essai | Mode défaut | Mode chrome |
|---|---|---|
| (a) Connexion au compte Google | | |
| (b) Gmail s'ouvre connecté | | |
| (c) YouTube connecté + lecture d'une vidéo | | |
| (d) daily.dev « Se connecter avec Google » | | |
| (e) Toujours connecté après redémarrage | | |

Messages d'erreur exacts :

**Conclusion :** Electron retenu / Repli à étudier
