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

Every visual change follows `DESIGN.md`.

## WebAiOs-Firefox e2e tests

- The suite runs 6 files in parallel (`maxWorkers: 6`, about 8 min measured 2026-11-12). At 9, time-sensitive tests break: do not raise it without making them robust.
- **For each change** (a plan's task, a small feature, a fix): run only the e2e files it touches or whose tested code it changes (`corepack pnpm --filter firefox-webaios exec vitest run -c vitest.e2e.config.ts e2e/<file>`).
- **The full suite**: only before a DMG goes to testers, not at the end of each feature or plan. A test that fails there and passes when its file is run alone is a load flake: say so, do not rerun the whole suite.
- Do not run the suite during the owner's `build:ui`: the binary disappears and everything fails with "build missing".

## Version and DMG

- The WebAiOs version is `"version"` in `apps/firefox/package.json`. To ship a DMG to testers, bump it there, then run `(set -a; . ~/.config/webaios/sentry.env; set +a; echo N | corepack pnpm --filter firefox-webaios run package)`. Sentry's release, Réglages › À propos, the DMG name and the Finder version all follow it. The package step takes a normal build.
- Never change `displayVersion` in `apps/firefox/surfer.json` for a WebAiOs release. It is compiled into Gecko, so a change forces a near-full engine rebuild (40+ min). It only moves with a Firefox engine update.
- Bump only for a DMG that actually goes to testers, not for every test build.
- With each bump, add the version's entry at the top of `apps/firefox/shared/release-notes.ts`: the « Nouveautés » page opens after the update only if the newest entry is for the running version.

## Specs, plans, notes; local settings

- They live outside the repo, in `../WebAiOs-docs/superpowers`. `docs/superpowers` is a git-ignored link to it (`ln -s ../../WebAiOs-docs/superpowers docs/superpowers`), so the usual paths keep working. Never commit them.
- The local plugin marketplace is declared in `.claude/settings.local.json` (git-ignored, absolute path): after a clone, add `extraKnownMarketplaces.webaios-local` with `{"source": "directory", "path": "<repo>/.claude/marketplace-local"}`.
