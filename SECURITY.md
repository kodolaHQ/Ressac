# Security

Ressac is a browser that lets an AI agent read and act on web pages. Security reports are welcome and taken seriously.

## Reporting a vulnerability

Please **do not open a public issue**. Report it privately through GitHub: the repository's **Security** tab › **Report a vulnerability**.

Include what you can: the Ressac version (Réglages › À propos), steps to reproduce, and what an attacker gains. You will get an answer as fast as possible. Ressac is a small project in beta: there is no bug bounty.

Bugs in Firefox itself (Gecko, SpiderMonkey, the network stack) belong to [Mozilla's security program](https://www.mozilla.org/security/), unless one of Ressac's patches causes them.

## Supported versions

Only the latest released version gets fixes. Ressac updates itself.

## What Ressac protects

The design assumes **web pages are hostile, including the ones the agent reads**: a page can try to give the agent instructions (prompt injection). The protections, in short:

- **The agent runs in a container**, not on your Mac. It sees its workspace folder and its own home volume; its servers are published on `127.0.0.1` only.
- **The agent reaches the browser only through the kernel's MCP server**, on `127.0.0.1`, with a per-session token.
- **Reading a tab needs your consent** (`packages/kernel/src/access/policy.ts`): the agent may read a tab you gave it, the tab you spoke to it from, or a local demo it built. Any other site needs a request, and a permission holds for one origin only. Developer rights (console, network, acting in the page) are granted one by one.
- **The agent does not click or type in pages.** It reads, navigates and hands control back to you for logins and captchas (`hand_over`). Two things you grant can act in a page: `run_js` on a tab (a developer right, per tab), and an extension the agent wrote once you turn it on.
- **An address the agent opens must be one it read, exactly** (`packages/kernel/src/mcp/seen.ts`): a page, one of its links or a search result, so `?q=<data>` added to a read address is not free. Outside a search, the fragment counts too (`page#<data>` is not free), and a local address, a tab it may read or an address you approved earlier in the conversation is also free. During a search, only that search's reads are free and a fragment the agent added is dropped. Any other address shows you a card with the whole address and the agent's reason before it opens. A site app you opened to the agent can be sent anywhere inside its own domains.
- **During a search, a judge watches the agent's gestures** against the search's stated goal, when the local AI is on (a small local model; it sees the tool and the address or query, never page content). A strange query pauses before it reaches the search engine; a strange `read_tab` of another tab, or a read of the history or the bookmarks, pauses too; on an address card it adds a warning but does not decide. It fails open: no model, an error or no answer in 3 s lets the gesture through. A search opened by `read_pages` without a reason has no goal until a `search_web` gives one. Outside a search there is no goal, so no judge: the exact-address rule and the cards remain.
- **Memories written from the web are data.** A site app's memory keeps each entry's page and date and reaches the agent only after your grant, marked as data. The agent's research notebook (`packages/kernel/src/search/notes.ts`) sits in a folder that is read-only in the container: the kernel writes a lesson only through `note_lesson`, once after a hand-over where the agent was lost, stamped with the date and that hand-over's sites, and gives the latest ones back with the `search_web` that opens a search, capped and marked as hints, never instructions.
- **Invisible reads** run in a private, throwaway container, and every request they make to a local address (or a name that resolves to one) is refused (`apps/firefox/chrome/agent/local-guard.ts`).
- **Workflow harvests** run in a disposable container with no network, a read-only file system and memory and process limits.
- **API keys stay in the macOS keychain**; the agent session only gets a relay token.

Known limits are marked with `shortcut:` comments in the code (for example custom-scheme navigations, preconnects and WebRTC in invisible reads). Others: once you grant `run_js` on a tab, or turn on an extension the agent wrote, script there can navigate or send anywhere without a card (a changed extension reloads without asking again while its rights stay the same); a click you make in a page the agent built can navigate out; a page that steers the agent during a search where it gets lost can still leave one lesson in the notebook; the judge fails open, only advises on address cards, and does not watch `capture_screen` or the developer reads. A way around one of the protections above is a vulnerability, even when it needs a crafted page.

## Out of scope

- What the agent does with permissions you granted it.
- Attacks that need full control of the user's Mac or Docker setup.
- Rate limiting and denial of service against your own machine.
