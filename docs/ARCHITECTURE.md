# Architecture

A one-page map of Ressac for a first-time reader. The details of each mechanism are in [apps/firefox/README.md](../apps/firefox/README.md).

## The big picture

Ressac is Firefox with a new interface on top and an agent beside it. Firefox does the browsing; Ressac adds the sidebar, the spaces, the command bar, and a bridge to an AI agent that runs in a container.

```
┌──────────────────────── Firefox window (Gecko, patched by surfer) ────────────────────────┐
│                                                                                           │
│  window controller (chrome/window)   ◄──── store module (chrome/store) ────► session file │
│     syncs Ressac tabs/spaces              shared state, settings,           in the data   │
│     with Firefox tabs/containers          shutdown save, updates            folder        │
│          │                                       │                                        │
│          ▼                                       │ JSON-RPC over stdio                    │
│  ┌──────────────┐  ┌────────────┐               ▼                                         │
│  │ sidebar      │  │ agent panel│     Node host (host/host.ts)                            │
│  │ iframe (ui/, │  │ iframe     │        └─ kernel (packages/kernel)                      │
│  │ Svelte)      │  │ (terminal) │             │                    │                      │
│  └──────────────┘  └────────────┘             │ docker             │ HTTP                 │
│                                               ▼                    ▼                      │
│  page actors (chrome/agent) ◄── MCP ── workshop container      llama-server               │
│  read/act in tabs for the agent        (Claude Code / Codex)   (local models)             │
└───────────────────────────────────────────────────────────────────────────────────────────┘
```

- **Firefox side** (privileged JavaScript, written in TypeScript and bundled by Vite): the window controller, the store, the UI iframes and the JSWindowActors that read and act in pages.
- **Node side**: a separate process started by Firefox. It hosts the kernel, which owns everything that is not a browser concern: the agent's container, its sessions, the MCP server the agent talks to, workflows, widgets, recaps.
- **The agent** runs in a Docker container (`ressac-workshop`), signed in with the user's own Claude or ChatGPT account. It reaches the browser only through the kernel's MCP server, which asks the browser over the same JSON-RPC link.
- **Local AI**: two small models run in the `llama-server` shipped with the app: d1-2B decides for workflows, watches and widgets, EmbeddingGemma finds pages for ⌘T, each on a free `127.0.0.1` port taken at launch. A workflow's web harvest runs in a throwaway container with no network.

## Where things live

| Path | What it holds |
|---|---|
| `apps/firefox/src/` | Files linked into the Firefox tree, and the few `*.patch` files applied to Gecko (C++, build files, `browser.xhtml`). |
| `apps/firefox/configs/` | Branding, mozconfig, macOS build settings. |
| `apps/firefox/chrome/window/` | The window controller: tabs, spaces, keys, site app windows, calls, add-ons toolbar. |
| `apps/firefox/chrome/store/` | The shared state module (`store.sys.mjs`): session, settings, permissions, downloads, updates, telemetry, import from other browsers. |
| `apps/firefox/chrome/agent/` | The browser half of the agent: the bridge to the host, page and extension actors, invisible reads and their network guard. |
| `apps/firefox/ui/` | The Svelte UI: sidebar, command bar, settings, home, agent panel, workflow builder. |
| `apps/firefox/core/` | Pure logic shared by the UI and the chrome, with no Firefox or DOM access: the state and its actions, tab cycling, history, sites. Easiest place to unit test. |
| `apps/firefox/shared/` | Types and helpers used on both sides of a boundary (RPC messages, settings schema, release notes, i18n). |
| `apps/firefox/host/` | The Node host: JSON-RPC server, Docker runtime, agent engines, keychain. |
| `apps/firefox/locales/` | Fluent files, French and English. |
| `packages/kernel/src/` | The kernel: `container/` (the workshop), `pty/` (agent sessions), `mcp/` (tools exposed to the agent), `access/` (what the agent may read), `workflows/`, `widgets/`, `recaps/`, `search/`… |
| `packages/kernel/templates/` | Instructions shipped to the agent (`AGENTS.md`, `CLAUDE.md`, and `guides/` read per task). |
| `packages/kernel/docker/` | The workshop image and the workflow engine that runs in the harvest container. |
| `apps/firefox/test/`, `packages/kernel/test/` | Unit tests (Vitest). |
| `apps/firefox/e2e/` | End-to-end tests: a headless Ressac on a throwaway profile, driven over Marionette, with a fake Docker and fake agents. |

## Build

[surfer](https://github.com/zen-browser/surfer) downloads Firefox into `engine/` (a symlink to a folder outside the repo), links `src/` into it, applies the patches and runs `mach`. `scripts/ui.sh` builds the TypeScript and Svelte bundles into `src/browser/base/content/ressac/`. Most UI work never recompiles Gecko: see « Work loop » in [apps/firefox/README.md](../apps/firefox/README.md).

## Names you will meet

Ressac was called **WebAiOs**. Some stored names keep the old spelling so user data needs no migration (`webaios-home`, `userContextIdInternal.webaios-*`); see « Coming from WebAiOs » in the app README. An **Electron** version came before the Firefox one; its code is gone, but a few tests and comments still mention it.
