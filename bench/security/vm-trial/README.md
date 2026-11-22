# VM trial: the bench's fixes in a signed DMG (2026-11-22)

DMG built from commit `f1a2f1e9` (on `main`), notarized (« Accepted »), stapled; `spctl` says « Notarized Developer ID », `codesign` OK. Ressac version 0.1.20; the engine reports 0.1.18 (`Services.appinfo.version` is the Firefox `displayVersion`, which does not follow Ressac's version). Installed in a throwaway Tart macOS VM.

The app is driven over ssh and Marionette:
1. In the VM: `open --env MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1 -a Ressac --args -marionette`.
2. On the host: `node servers.mjs <hits.jsonl>`. Port 5300 plays the agent's server, 8098 an ordinary local page, 8099 the witness « web ». They listen on the host address the VM reaches (`VM_HOST_IP`, default `192.168.64.1`, Tart's NAT gateway).
3. On the host: `./vtunnel <vm-ip>`. It forwards host `127.0.0.1:28280` to the VM's Marionette (2828), and the VM's `localhost:5300` back to the host's 5300, so the agent pages are on the VM's real localhost.
4. On the host, from the repo root: `packages/kernel/node_modules/.bin/tsx bench/security/vm-trial/drive.mts <hits.jsonl> results.json`.

`vssh <vm-ip> <command>` and `vscp <file> <vm-ip> <path>` wrap ssh and scp with Tart's default login (`admin` / `admin`); they need `expect`.

Result (`results.json`): 7/7 OK, control cases included (C1, C2, A6 control), which show the network itself let those requests through.

For A6, two settings hold only for that step:
- `network.dns.forceResolve` points the CDN names at the host;
- the HSTS preload list is off. Without that, Firefox already upgrades unpkg and jsDelivr to https, and the clear-text witness sees nothing. So in practice the A6 hole only reached CDNs outside that list.

Not testable in Tart (no nested virtualization): the agent and its container, hence auto-memory being off, the MCP rules and the kernel's fetch.
