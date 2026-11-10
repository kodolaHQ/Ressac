# WebAiOs: notes for Claude

## Searching the code: LSP or grep

Two LSP servers run through the `LSP` tool (local plugins in `.claude/marketplace-local`):
- `tsgo-lsp`: `tsc --lsp` from TypeScript 7 (no tsserver, hence this plugin). It does **not** see `.svelte` files.
- `svelte-lsp`: svelte-language-server with its own TypeScript 6. It only sees open `.svelte` files.

Rule:
- **Before changing an exported function, component or type** → `LSP findReferences` on its definition (from a `.svelte` that uses it if some callers are in Svelte), to know every caller before writing.
- **"Who calls this method?" on a common name** (`fermer`, `ouvrir`…) → `LSP findReferences` on the definition. E.g. `Vues.fermer`: 3 exact calls, against 120 lines for grep `.fermer(`.
- **Calls inside `.svelte` files** → run the query from a `.svelte` file that uses the symbol, not from the defining `.ts`.
- **A type or name used in several `.svelte` files, strings, IPC channels, entry points** → grep. The LSP misses some.

If `apps/firefox/node_modules/typescript` moves, update the path in `.claude/marketplace-local/plugins/tsgo-lsp/.lsp.json`.
After a clone: `npm ci` in `.claude/marketplace-local/plugins/svelte-lsp`.

## WebAiOs-Firefox e2e tests

- The suite runs 6 files in parallel (`maxWorkers: 6`, about 2 min). At 9, time-sensitive tests break: do not raise it without making them robust.
- **During a plan's task**: run only the e2e files the task touches or whose tested code it changes (`corepack pnpm --filter firefox-webaios exec vitest run -c vitest.e2e.config.ts e2e/<file>`).
- **The full suite**: once at the end of the plan, before the final review, and after the final fix pass.
- Do not run the suite during the owner's `build:ui`: the binary disappears and everything fails with "build missing".

## Specs, plans, notes; local settings

- They live outside the repo, in `../WebAiOs-docs/superpowers`. `docs/superpowers` is a git-ignored link to it (`ln -s ../../WebAiOs-docs/superpowers docs/superpowers`), so the usual paths keep working. Never commit them.
- The local plugin marketplace is declared in `.claude/settings.local.json` (git-ignored, absolute path): after a clone, add `extraKnownMarketplaces.webaios-local` with `{"source": "directory", "path": "<repo>/.claude/marketplace-local"}`.
