# Ressac: notes for Claude

Maintainer-only notes, if any, live in `CLAUDE.local.md` (git-ignored, loaded by Claude Code when present).

## Searching the code: LSP or grep

Two LSP servers run through the `LSP` tool (local plugins in `.claude/marketplace-local`):
- `tsgo-lsp`: `tsc --lsp` from TypeScript 7 (no tsserver, hence this plugin). It does **not** see `.svelte` files.
- `svelte-lsp`: svelte-language-server with its own TypeScript 6. It only sees open `.svelte` files.

Rule:
- **Before changing an exported function, component or type** → `LSP findReferences` on its definition (from a `.svelte` that uses it if some callers are in Svelte), to know every caller before writing.
- **"Who calls this method?" on a common name** (`close`, `open`…) → `LSP findReferences` on the definition: it returns the exact calls where grep returns every line with that word.
- **Calls inside `.svelte` files** → run the query from a `.svelte` file that uses the symbol, not from the defining `.ts`.
- **A type or name used in several `.svelte` files, strings, IPC channels, entry points** → grep. The LSP misses some.

If `apps/firefox/node_modules/typescript` moves, update the path in `.claude/marketplace-local/plugins/tsgo-lsp/.lsp.json`.

After a clone:
- `npm ci` in `.claude/marketplace-local/plugins/svelte-lsp`.
- Declare the local plugin marketplace in `.claude/settings.local.json` (git-ignored, absolute path): `extraKnownMarketplaces.ressac-local` = `{"source": "directory", "path": "<repo>/.claude/marketplace-local"}`.

Every visual change follows `docs/DESIGN.md`. New code, comments and identifiers are in English; the UI text is French.

## e2e tests

- The suite runs 6 files in parallel (`maxWorkers: 6`, about 8 min on an M5 Pro). At 9, time-sensitive tests break: do not raise it without making them robust.
- **For each change**: run only the e2e files it touches or whose tested code it changes (`corepack pnpm --filter firefox-ressac exec vitest run -c vitest.e2e.config.ts e2e/<file>`).
- **The real macOS menu bar** (headless has none): before a release, `RESSAC_NATIVE_MENU=1 corepack pnpm --filter firefox-ressac exec vitest run -c vitest.e2e.config.ts e2e/app-menu-native.e2e.ts`. It opens a visible window and needs the terminal's Accessibility access; 0.1.9 crashed as soon as the app menu opened.
- **The full suite**: before a release, not after each feature. A test that fails there and passes when its file is run alone is a load flake: say so, do not rerun the whole suite.
- Do not run the suite during a `build:ui`: the binary disappears and everything fails with "build missing".

### Writing e2e that hold under load

Every rule below comes from a test that failed on a busy machine. A red must mean a bug.
- **Wait for the final state, never read once.** After a click, load or message, `expect.poll` / `waitFor` / `waitUi` on what must end up true (a list that loads, a file written after the answer, a live update, a counter).
- **No fixed sleep decides a pass.** A positive check waits on its condition. A "must not happen" check keeps a short window, started after the last thing that could cause it (an event, the end of retries), with a comment saying which.
- **No wall-clock budget.** `toBeLessThan(ms)` on elapsed time fails on a loaded Mac. Bound well below the slow fallback it rules out (≥ 2×, say which), time it where the timer lives, use CPU time, or drop it when the result already proves the point.
- **A two-step window the product allows (1 s, 300 ms) is done in one script**, in the process that owns the timer: Marionette round trips between the steps eat the window.
- **A transient state the test must see** (« Lancement… », a build step, « 2 / 3 ») is held by the fake until the test has seen it (the fake waits for a file the test writes).
- **Press only what can take the press:** `click` waits for armed buttons; wait for a frame's process to know its scroll position, for a page to have a size, for a window that steals focus to have taken it.
- **Transitions:** no rAF sampling (hidden windows run few frames). Listen to `transitionrun`/`transitionend`, or pause and seek the animation.
- **Each test passes alone with `-t`.** No snapshot of global state left by earlier tests (refusals, counters, files): scope checks to what this test causes.
- **Handles can vanish** between listing and switching (`no such window`): keep polling. **Lazy getters lie:** an unloaded tab's `currentURI` is its page; wait on a loaded fact.
- **Teardown waits for processes**, not a retry on `rm` (`launch.ts` waits for Firefox's process group).
- **Reproduce a flake before fixing it:** 6-12 copies of the file or test at once (`-t`), plus `yes > /dev/null` hogs, count failures before and after; probes go to a file (vitest hides console). Copies collide on fixed port blocks: give each its own while measuring.

## Version and release

- The Ressac version is `"version"` in `apps/firefox/package.json`. Sentry's release, Réglages › À propos, the DMG name and the Finder version all follow it.
- `corepack pnpm --filter firefox-ressac run package` builds `apps/firefox/dist/Ressac-<version>.dmg` (it runs a normal build first; pipe `echo N |` so surfer never waits on a prompt). Optional environment: `RESSAC_SENTRY_DSN` (telemetry), `RESSAC_SIGN_IDENTITY` (a « Developer ID Application » identity in the keychain) and `RESSAC_NOTARY_PROFILE` (a `xcrun notarytool store-credentials` profile). Without the last two the DMG is ad hoc signed and Gatekeeper blocks it.
- Only for a version that goes to testers, after `package`: `corepack pnpm --filter firefox-ressac run release:publish` uploads it to the update server (Cloudflare R2, `npx wrangler login` once). See « Publish a release » in `apps/firefox/README.md`.
- Never change `displayVersion` in `apps/firefox/surfer.json` for a Ressac release. It is compiled into Gecko, so a change forces a near-full engine rebuild (40+ min). It only moves with a Firefox engine update.
- With each version bump, add the version's entry at the top of `apps/firefox/shared/release-notes.ts`: the « Nouveautés » page opens after the update only if the newest entry is for the running version.
