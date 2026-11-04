# WebAiOs : notes pour Claude

## Chercher dans le code : LSP ou grep

Deux serveurs LSP tournent via l'outil `LSP` (plugins locaux dans `.claude/marketplace-local`) :
- `tsgo-lsp` : `tsc --lsp` de TypeScript 7 (pas de tsserver, d'où ce plugin). Ne voit **pas** les `.svelte`.
- `svelte-lsp` : svelte-language-server avec son propre TypeScript 6. Ne voit que les `.svelte` ouverts.

Règle :
- **Avant de modifier une fonction, un composant ou un type exporté** → `LSP findReferences` sur sa définition (depuis un `.svelte` qui l'utilise si des appelants sont en Svelte), pour connaître tous les appelants avant d'écrire.
- **« Qui appelle cette méthode ? » sur un nom courant** (`fermer`, `ouvrir`…) → `LSP findReferences` sur la définition. Ex. `Vues.fermer` : 3 appels exacts, contre 120 lignes pour grep `.fermer(`.
- **Appels situés dans des `.svelte`** → lancer la requête depuis un fichier `.svelte` qui utilise le symbole, pas depuis le `.ts` de définition.
- **Type ou nom utilisé dans plusieurs `.svelte`, chaînes, canaux IPC, points d'entrée** → grep. Le LSP en rate.

Si `apps/navigateur/node_modules/typescript` change de place, mettre à jour le chemin dans `.claude/marketplace-local/plugins/tsgo-lsp/.lsp.json`.
Après un clone : `npm ci` dans `.claude/marketplace-local/plugins/svelte-lsp`.

## Tests e2e de WebAiOs-Firefox

- La suite tourne 6 fichiers en parallèle (`maxWorkers: 6`, environ 2 min). À 9, des tests sensibles au temps cassent : ne pas monter sans les rendre robustes.
- **Pendant une tâche d'un plan** : lancer seulement les fichiers e2e que la tâche touche ou dont elle change le code testé (`corepack pnpm --filter firefox-webaios exec vitest run -c vitest.e2e.config.ts e2e/<fichier>`).
- **La suite complète** : une fois à la fin du plan, avant la relecture finale, et après la passe de corrections finale.
- Ne pas lancer la suite pendant un `build:ui` du propriétaire : le binaire disparaît et tout échoue en « build missing ».
