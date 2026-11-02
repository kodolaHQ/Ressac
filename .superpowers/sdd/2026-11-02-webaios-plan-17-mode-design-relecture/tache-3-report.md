# Tâche 3 - rapport

Statut : DONE_WITH_CONCERNS (voir concerns).

Construit : `packages/noyau/src/relecture/diff.ts` (parserDiff, positionNouvelle, pur) et `depot.ts` (DepotRelecture, ErreurRelecture, gitDisponible, constantes). Opérations d'un même dépôt sérialisées (file de promesses par chemin de dépôt). Export dans `index.ts` ; `Bloc` de diff.ts réexporté sous `BlocDiff` (conflit avec `Bloc` de workflows/schema).

RED : `pnpm --filter @webaios/noyau test relecture` -> 2 files failed, "no tests" (modules absents).
GREEN : 17 tests relecture passent (3 exécutions consécutives), + garde-electron : 20 passed ; suite noyau complète 1364 passed ; `pnpm -r typecheck` OK.

Choix / écarts à la brief :
- `--raw -z` (au lieu de `--name-status`) pour lire les modes et ignorer 160000.
- Env supplémentaire : GIT_OPTIONAL_LOCKS=0 (sans lui, `git add -A` rafraîchit l'index d'un sous-dépôt imbriqué : mtime modifié, détecté par le test), HOME et XDG_CONFIG_HOME = dépôt privé (pas d'ignore global), GIT_CEILING_DIRECTORIES, `init --template=` (pas de hooks exemples).
- Sous-dépôt imbriqué sans commit : `git add` échoue ("does not have a commit checked out") ; on l'ajoute à info/exclude (`/sous/`) et on relance (max 50 fois). Sous-dépôt avec commit : gitlink 160000, ignoré dans la comparaison.
- ACCES_REFUSE : pré-vérification access(R_OK|X_OK) du dossier + motif stderr de `add`.
- Fichier supprimé : taille lue dans l'arbre relu ; limite : > 1 048 576 octets = trop-gros (1 048 576 exact reste affichable, testé).

Concerns : un sous-dépôt imbriqué sans commit est exclu définitivement (info/exclude) même s'il reçoit des commits plus tard (le gitlink serait ignoré de toute façon). chmod 000 testé seulement hors root.

## Correctif, tour 1
- preparer() : `gitDisponible(this.git)` vérifié une fois par instance (mis en cache) -> GIT_NECESSAIRE si `--version` échoue ; `readdir(dossier)` en plus de `access` -> ACCES_REFUSE.
- `git add -A` : stderr lu même en cas de succès (lancer() accepte un récepteur d'avertissements) ; « could not open directory|Permission denied|Operation not permitted » -> ACCES_REFUSE.
- Tests ajoutés : faux git qui sort 1 (GIT_NECESSAIRE), WEBAIOS_GIT=/chemin/absent (GIT_NECESSAIRE), sous-dossier chmod 000 (ACCES_REFUSE, ignoré en root).
- `pnpm --filter @webaios/noyau test relecture` : 20 passed ; `pnpm -r typecheck` OK.
