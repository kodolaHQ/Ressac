# Contributing

Thanks for looking at Ressac. It is a small project in beta, so a few rules keep it manageable.

## Before you start

- **Bugs**: open an issue with the version (Réglages › À propos), what you did, what you expected and what happened.
- **Small fixes** (a typo, a clear bug with an obvious fix): send a pull request directly.
- **Anything bigger** (a feature, a change of behaviour, a refactor): open an issue first, so we agree on it before you spend time on it.
- **Security issues**: never in public, see [SECURITY.md](SECURITY.md).

## Setting up

Follow « Build from source » in the [README](README.md). The first full build takes about 20 minutes; after that most changes only need `pnpm ui` or `pnpm build:ui` (about 20 seconds), see « Work loop » in [apps/firefox/README.md](apps/firefox/README.md). Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) to find your way.

## Rules for the code

- **Code, comments and identifiers are in English. The interface is in French and English**: every new string goes in both files under `apps/firefox/locales/`.
- **Every visual change follows [docs/DESIGN.md](docs/DESIGN.md)**, including its animations: nothing appears or disappears without a transition.
- Keep changes small and focused. Prefer the helpers and patterns already in the code to new ones.
- Add a test for new logic: a unit test when it can live in `core/` or the kernel, an e2e test when it needs the browser.
- A deliberate limitation gets a comment `shortcut: <the limit>, <when to lift it>`.

## Tests

```sh
corepack pnpm test                # unit tests, all packages
corepack pnpm typecheck
corepack pnpm --filter firefox-ressac exec vitest run -c vitest.e2e.config.ts e2e/<file>   # one e2e file
```

The e2e tests need a build. Run the files your change touches; the whole suite takes several minutes and runs before each release. A test that fails in the full suite but passes alone is probably a load flake: say so in the pull request.

## Pull requests

- One topic per pull request, with a description of what changes for the user and how you tested it.
- Commit messages follow `type(scope): what changes`, for example `fix(tabs): keep the folder when a pinned tab moves`.
- By contributing you agree that your work is published under the [Mozilla Public License 2.0](LICENSE).
