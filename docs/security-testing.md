# How we tested Ressac's security

[SECURITY.md](../SECURITY.md) lists what Ressac promises: what the agent can reach, what stops it from sending your data out, and how updates and telemetry behave. In November 2026 we checked every one of those promises, brick by brick, before testers or attackers would. This page explains how, what held, what broke and what is still untested.

The bench ran on Ressac 0.1.20. It took most of the 21st and 22nd of November 2026.

## Why

Two ideas we measured that month did worse than we hoped:
- a small local model meant to spot hostile searches let 87% of the attacks through, so we removed it;
- a « doubtful site » warning stayed below the criteria we had set for it beforehand, so it is on hold.

So we stopped trusting how our protections looked on paper and tested each one.

## Method

1. **Claims first.** Each sentence of SECURITY.md that promises something became a numbered claim, with the attack that would prove it false. The attack lists were written and frozen (with a checksum) before any test ran.
2. **Criteria set in advance.**
   - **Deterministic barriers**, such as the network allowlist, the container's mounts, the exact-address rule and the page guards, must have **0 bypass**. One bypass means the claim is broken until it is fixed and retested.
   - **Probabilistic layers**, such as the outflow rules and the cards' real effect, get a rate with its confidence interval and its cost in false alarms.
3. **The tests must be able to fail.** We removed or weakened each guard on purpose (mutation testing) and checked that a test turned red. A test that stays green without its guard counts as no test.
4. **The real build, not a mock.**
   - Barriers were attacked on the shipped VM image, and on a signed and notarized DMG in a throwaway macOS VM.
   - The kernel's MCP server was attacked as it runs, with a scripted client playing the agent.
5. **Outside eyes.** Each attack list was written by an agent that had not built the brick, working from the code and SECURITY.md only. Each fix was reviewed by another fresh agent. Two of those reviews found further holes, now fixed.
6. **Honest reporting.** Every bypass is named, and every limit that stays is written in SECURITY.md.

## Results

| Brick | What was attacked | Result |
|---|---|---|
| Do the tests test? | 297 mutations over 31 security files | 223 caught; 43 guards could be removed with every test green. Tests for those holes are being added. |
| The agent's network | direct TCP, UDP, ICMP, IPv6, raw sockets, the allowlist proxy (CONNECT, plain HTTP, IP literals, names resolving to private addresses), the Mac's ports | **0 bypass** |
| VM and container isolation | mounts, home folder, SSH keys and agent, forwarded ports, capabilities, cgroup limits, user namespaces, the image and agent binaries, `.ressac` read-only, planted links | **0 bypass** |
| What the agent reaches in the browser | 134 attacks on the MCP server: tokens, consent, private spaces, history, the exact-address rule, recaps, sensitive sites | **4 bypasses**, fixed (one partly) |
| The agent cannot change its own rules | managed settings, instruction files, skills, hooks, auto-memory, npm scripts, in Claude and Codex | **1 bypass**, fixed |
| Keys and relay | key exposure, token swap, paths, methods, engines | **0 bypass**, 1 limit written |
| Pages and apps the agent builds; Ressac's interface | 152 attacks: agent pages, site apps, widget frames, the kernel's fetch, the design server | **3 bypasses**, fixed |
| Updates and telemetry | signing with throwaway keys, version checks, publishing, the error scrub in the real app | **1 bypass** (the scrub), fixed; limits written |

## What broke, and what we did

1. **The auto-memory file.** In Navigateur mode, Claude still loaded its auto-memory file. The instruction check, which shows you every change the agent makes to its own instructions, did not watch that file. Auto-memory is now off in Navigateur.
2. **A stale link list.** The agent could follow a link from a list that the page no longer offered. A list that was rewritten is now refused.
3. **Encoded addresses.** The sensitive-site check missed paths written with percent-encoding or `;parameters` (`/%73ettings`). Paths are now decoded the way servers route them.
4. **Switching tokens.** The agent's tokens are readable inside its container, so it could switch token to escape one window's rules. Fixed in part:
   - the main token is now checked against what every window read;
   - sensitive sites ask again during any window's search.

   What stays open is written in SECURITY.md.
5. **The Mac's own address.** The kernel's fetch, for widgets and actions, treated the Mac's own global IPv6 address and its network as the public web. Fixed. A review then found the same gap for public IPv4 networks, also fixed.
6. **The error scrub.** Error reports could carry folder names, bare host names, e-mail addresses, IP addresses and quoted text. In the real app, all 11 crafted cases are now scrubbed. A review found the new scrub could stall on a very long message; fixed.
7. **Redirects by the agent's server.** An address you typed, then redirected by the agent's server, could leave for the web. A review found the same for a link on any web page. Every redirect hop from the agent's server is now judged.
8. **CDNs.** The five allowed CDNs were matched by name only, so plain HTTP on any port passed. They are now allowed over HTTPS on their usual port only.

Each fix has a test that fails without it. The redirect and CDN fixes were also checked in the signed DMG in a macOS VM: 7 of 7 cases, with control cases showing the network itself let those requests through.

## What is not tested yet

- **End-to-end prompt injection.** How often a hostile page actually makes data leave, through every layer at once, with a real model. This is the number users care about, and it is the next step.
- **The agent inside the VM trial.** The macOS test VMs cannot run the agent's own Linux VM (no nested virtualization), so the agent-side fixes were checked by unit and end-to-end tests, and once by hand on a real Mac.
- **The update path end to end.** The real updater with tampered, foreign or older archives, and a moved feed.
- **The Docker fallback**, used instead of Ressac's own VM on some setups.
- **An outside review.** No independent security review has seen these results yet. It is wanted before any public security claim.

The bench's scripts depend on our machines and are not published yet. The regression tests for every fix are in the normal test suites.
