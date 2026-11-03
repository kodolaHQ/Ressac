# WebAiOs on Firefox

WebAiOs rebuilt on stable Firefox. Built with [surfer](https://github.com/zen-browser/surfer), which downloads Firefox into `engine/`, symlinks our `src/` files into it (same relative path), applies our `*.patch` files (`git apply`) and runs `mach`.

## Requirements (macOS arm64)

- `brew install gnu-tar python@3.12`; Rust in `~/.cargo/bin`; Mozilla toolchains in `~/.mozbuild` (installed by `engine:bootstrap` if needed).
- About 25 GB free: the Firefox sources live in `~/WebAiOs-firefox/engine`, and `engine/` is a symlink to them.
- Every command goes through `scripts/env.sh` (PATH, SDK): use the pnpm scripts.

## First install

```sh
pnpm --filter firefox-webaios engine:install   # downloads Firefox 159.0.1, moves it out of the repo, links it
zsh apps/firefox/scripts/branding.sh           # placeholder icons (Firefox "unofficial" branding)
cd apps/firefox && pnpm exec surfer set brand webaios
pnpm engine:import                             # links src/ and applies the patches
pnpm build                                     # full build (~20 min)
```

In a new checkout or worktree: `pnpm engine:link` then `pnpm engine:import`. The `engine` tree is shared between checkouts: run `engine:import` in the checkout you work in before building.

## Measured times (M5 Pro, 2026-11-03, Firefox 159 + Zen patches)

Full build 20 min; `build:ui` after a JS change 14 s; one C++ or Objective-C++ file 23–25 s; build with no change 21 s.

## Pitfalls

- The macOS 27 SDK breaks Mozilla's linker (unknown `arm64e.x1`): SDK 26.5 is forced (`configs/macos/mozconfig`, `scripts/env.sh`).
- A truncated Firefox archive stays cached in `.surfer/engine/` after an interrupted download: delete it.
- surfer declares a git fork of `is-apple-silicon`, which pnpm rejects: replaced by the registry version (`pnpm-workspace.yaml`).
- The icons in `configs/branding/webaios/` are placeholders.
