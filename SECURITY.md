# Security

Ressac is a browser that lets an AI agent read and act on web pages. Security reports are welcome and taken seriously.

## Reporting a vulnerability

Please **do not open a public issue**. Report it privately through GitHub: the repository's **Security** tab › **Report a vulnerability**.

<!-- TODO: add a contact email once chosen. -->

Include what you can: the Ressac version (Réglages › À propos), steps to reproduce, and what an attacker gains. You will get an answer within a week. Ressac is a small project in beta: there is no bug bounty.

Bugs in Firefox itself (Gecko, SpiderMonkey, the network stack) belong to [Mozilla's security program](https://www.mozilla.org/security/), unless one of Ressac's patches causes them.

## Supported versions

Only the latest released version gets fixes. Ressac updates itself.

## What Ressac protects

The design assumes **web pages are hostile, including the ones the agent reads**: a page can try to give the agent instructions (prompt injection). The protections, in short:

- **The agent runs in a container**, not on your Mac. It sees its workspace folder and its own home volume; its servers are published on `127.0.0.1` only.
- **The agent reaches the browser only through the kernel's MCP server**, on `127.0.0.1`, with a per-session token.
- **Reading a tab needs your consent** (`packages/kernel/src/access/policy.ts`): the agent may read a tab you gave it, the tab you spoke to it from, or a local demo it built. Any other site needs a request, and a permission holds for one origin only. Developer rights (console, network, acting in the page) are granted one by one.
- **Addresses the agent wrote itself are confirmed** by you before they open, and the agent hands control back for logins and captchas.
- **Invisible reads** run in a private, throwaway container, and every request they make to a local address (or a name that resolves to one) is refused (`apps/firefox/chrome/agent/local-guard.ts`).
- **Workflow harvests** run in a disposable container with no network, a read-only file system and memory and process limits.
- **API keys stay in the macOS keychain**; the agent session only gets a relay token.

Known limits are marked with `shortcut:` comments in the code (for example custom-scheme navigations, preconnects and WebRTC in invisible reads). A way around one of the protections above is a vulnerability, even when it needs a crafted page.

## Out of scope

- What the agent does with permissions you granted it.
- Attacks that need full control of the user's Mac or Docker setup.
- Rate limiting and denial of service against your own machine.
