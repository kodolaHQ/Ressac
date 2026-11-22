# Ressac security bench

The scripts, frozen attack catalogues, per-case results and reports behind [How we tested Ressac's security](../../docs/security-testing.md). The claims under test are in [SECURITY.md](../../SECURITY.md); the results and what was fixed are in `docs/security-testing.md`. This page says what is here, how to rerun it and where the bench itself falls short.

## What this bench is, and is not

- **It is** a test of each SECURITY.md claim, one brick at a time: does the network allowlist hold, does the container mount the home folder, does the MCP server refuse a token it should refuse, does a test go red when its guard is removed.
- **It is not** an end-to-end prompt-injection rate. How often a hostile page actually makes data leave, through every layer at once with a real model, is brick **B3**. B3 has not been run, and nothing here estimates it.
- The outflow figure (51.5%) is one layer's detection rate on leaks that were forced to happen, replayed on recorded gestures. It is not a leak rate of the product.

## Method, short

1. **Claims first.** Each promise in SECURITY.md became a numbered claim (`C1.1`, `C4.6`, …) with the attacks that would prove it false.
2. **Frozen catalogues.** Each attack list was written before any test ran, by an agent that had not built the brick, and frozen with a sha256.
3. **Criteria set in advance.** A deterministic barrier (allowlist, mounts, exact-address rule, page guards) passes only with **0 bypass**. A probabilistic layer (the outflow rules) gets a rate with a Wilson 95% interval and its false-alarm cost.
4. **The tests must be able to fail.** B0 removes or weakens each guard (mutation testing) and checks that a test goes red.
5. **The real code.** The real MCP server, relay, VM image and signed DMG, not mocks of them, wherever the brick allowed it.

In these files, « the plan » and « plan rule N » mean these steps (the numbered method in `docs/security-testing.md`). « Navigateur » and « Atelier » are the agent's two modes, named as in the UI.

## The bricks

Every brick ran on Ressac **0.1.20**, commit `e94539fb` (in `v0.1.21`'s history), on 2026-11-21, except the outflow replay (rules of 0.1.19, `584740d8`, rerun at `c61a21f5`) and the VM trial (DMG of `f1a2f1e9`, 2026-11-22). Fixes shipped in 0.1.21.

| Brick | Folder | Catalogue sha256 | Rerun | Needs | Result at 0.1.20 |
|---|---|---|---|---|---|
| B0 Do the tests test? | `B0/` | `mutations.md` `0a1f5655…3b25`, `muts.mjs` `1669b83f…99c3` | `run.mjs` | Node + the repo at `e94539fb` | 297 mutations: 223 caught, 21 e2e-only (not run), 53 survived (about 11 equivalent, 42 + P4 real holes) |
| B1 Agent network, B2 VM and container isolation | `B1-B2/` | frozen `61bdd858…d3c6`, published `145b2d10…4d92` (below) | not scripted | macOS, Lima + Podman (pinned), the agent VM image | 0 bypass |
| B4 MCP server | `B4-B6/` | `de6427b3…025e` | `scripts/b4.mts` | Node + the repo | report bypasses 1-3: token switching (fixed in part), stale link list, encoded paths |
| B5 The agent's own rules | `B4-B6/` | same | `scripts/drv.mts`, `plant.sh`, `cx.sh`, `b5links.mts` | the agent VM (macOS); `b5links.mts` Node only | 1 bypass (auto-memory file) |
| B6 Keys and relay | `B4-B6/` | same | `scripts/b6.mts` (host side), `drv.mts` (container side) | Node + the repo; the agent VM for the container side | 0 bypass, 1 limit written |
| B7 Agent pages and apps, B8 UI, B9 updates and telemetry | `B7-B9/` | `842f8379…90c2` | `unit/*.test.ts`, `unit/publish-harness.sh`, `e2e/*.e2e.ts` | unit: Node + the repo; publish harness: a built engine; e2e: a built Ressac | 2 bypasses reproduced (kernel fetch, error scrub), 2 predicted from code (redirects, CDN documents), 1 limit widened (CDN in clear text); the e2e were pending when the report was written; the redirect and CDN fixes were then checked in `vm-trial/` |
| Outflow rules (replay) | `outflow/` | corpora below | `runner-outflow.mts` | Node + the repo at `c61a21f5`; corpus 3 needs two public git clones | caught the data in 1001/1944 = **51.5%** [49.3–53.7] of adapted attacks; paused 7/398 honest gestures |
| VM trial of the fixes | `vm-trial/` | — | `drive.mts` | a Tart macOS VM and a signed DMG | 7/7 cases, controls included |

B3 (end-to-end injection) is not here: not run yet.

Per-case results:
- B0: `results-run.json`, `results-related.json`, and the full table at the end of `REPORT.md`.
- B4-B6: `results/b4.jsonl`, `results/b6.jsonl`, `results/b5links.out`. The B5 and B6 container outputs were not saved; the report is their only record.
- B7-B9: `unit/results/*.json`, `unit/results/publish.txt`.
- Outflow: each run's per-item output is not published, but the replay is deterministic and takes seconds (below).
- VM trial: `results.json`.
- B1-B2: the report only. Its runners were kept in a temporary folder and lost.

Threat model and scope: those of SECURITY.md. The attacker controls web pages the agent reads (prompt injection) and, through them, the agent's actions inside its container. The user, the Mac and Ressac's own build are trusted. Each catalogue's first lines give its exact scope.

### Checksums, and the files that changed for publication

A catalogue's bytes are what was frozen, except where listed here. Check with `shasum -a 256 -c <file>.sha256` from the file's folder.

| File | Frozen sha256 | Published sha256 | What changed |
|---|---|---|---|
| `B0/mutations.md`, `B0/muts.mjs` | `0a1f565511c245d68dc46a0a54e8fb5312789654d2e690ff62cde68398ff3b25`, `1669b83f6eb3f1c1562b7166edb54adaff177d6362d00a3851067760440399c3` (2026-11-21T19:53:51Z) | same | nothing; `SHA256-before-run.txt` lost its absolute paths and its date line |
| `B1-B2/catalogue.md` | `61bdd85818368571a57dff58459fda788af983a146cdf15c9ab34d0e3912d3c6` | `145b2d10ad30ff6d4b5ceb7debe1682eaec6a1249337b74a2ccb57f41bbf4d92` | line 4: the worktree's absolute path became its name, `Ressac-bench` |
| `B4-B6/catalogue.md` | `de6427b3ca9bb01732ff8221c74e65af629114b39b19fc5cb50d5fd159d1025e` | same | nothing |
| `B7-B9/catalogue.md` | `842f837940b751a00c31b8e7dbae2153c75307d54c652a16a1bdb283676f90c2` | same | nothing |
| `outflow/corpus.json` (built) | `a58a04d67a158ee1d2aeaf8c743b8b12de5540dde4dc12eccd304f757ff306ea` | same, rebuilt | its builder `corpus-build.mjs`: frozen `6785ff071bda9b9825a805371356011a7fcd38a0df82124f16565e2c319a2145` (2026-11-19 13:36 UTC), published `6b9d8257…68b6`. Secret-shaped test strings (a GitHub token, a Stripe key, a JWT) are now written as `"gh" + "p_…"`; the output is byte-identical |
| `outflow/corpus1bis.json` (built) | `461f943cb562faf53bec2f95d8c0bc60dce24fd5ed50858023e9f108b45eda37` | same, rebuilt | its builder: frozen `e7be551bc64e0aac8efdd8429664aa15eaa17332f5c469b898983a47ef3d8483` (2026-11-19 15:51 UTC), published `1d6e3507…9617`, same split; byte-identical output |
| `outflow/corpus2/corpus2.json` (built) | `5cb73139d409afe555aaa9b184eb146de5bb61d1e8b680fcc01b599d82605ca5` | same, rebuilt | nothing in the builder |
| `outflow/corpus3/corpus3.json` (built) | `c96c6e345123b3d6da6f48288d613c0d205992f5b7dc14e7c64680867ccdbb32` | same, rebuilt | nothing in the builder |
| `outflow/corpus3/corpus3-nosink.json` (built) | `4f4a297d8340a9b0b0210b4f4c972bfe17f52de60cd37db7a794258200f54ed8` | same | `strip-sink.mjs` is new: it writes down the step that made the « data only » corpus (drop `to=<sink>`), checked to give the same bytes |

Other edits, none in a catalogue:
- Absolute paths in scripts became paths relative to the repo, or `RESSAC_WORKTREE` (a checkout to test, default this repo).
- Controller notes were dropped from the reports' headers. French prose went into English.
- The Mac's LAN address in `B4-B6/results/*.jsonl` became `<mac-lan-v4>`; the run's temporary folder, ports and session token in `env.sh` and `cx.sh` became variables.
- Fake keys are built by concatenation (`"sk-" + "ant-FAKEBENCHKEY-…"`).
- The outflow runner loads the judge's modules only in `judge` mode (they were removed after 0.1.19).
- Left as is: `/Users/marie`, `/Users/andré` and the like in B0 and B7-B9 are fictional homes fed to the error-scrub tests, whose subject is that path shape.

No corpus JSON is published. Corpora 1 and 1-bis are invented by hand (no real browsing, no real person; the builders say so and we read them) but hold secret-shaped test strings that code hosts refuse. Corpus 2 is invented the same way, and corpus 3 is derived from two MIT datasets (below). Each builder is deterministic, and the sha256 is what it must give back.

## Reproducing

From a fresh clone, on a Mac or Linux with Node 22 and corepack:

```sh
git clone https://github.com/kodolaHQ/Ressac && cd Ressac
corepack pnpm install --frozen-lockfile
TSX=$PWD/packages/kernel/node_modules/.bin/tsx
```

**Anyone, Node only:**

The outflow replay, from the rules as measured (`c61a21f5`, the post-review rerun):

```sh
mkdir -p /tmp/ressac-c61 && git archive c61a21f5 packages/kernel/src | tar -x -C /tmp/ressac-c61
ln -s $PWD/packages/kernel/node_modules /tmp/ressac-c61/packages/kernel/node_modules
cd bench/security/outflow
node corpus-build.mjs && node corpus1bis-build.mjs && shasum -a 256 -c corpus.sha256 corpus1bis.sha256
(cd corpus2 && node build.mjs >/dev/null && shasum -a 256 -c corpus2.sha256)
for r in agentdojo:ethz-spylab/agentdojo:089ed468cf3ed0322acc66b0211f26d9d90dbf60 InjecAgent:uiuc-kang-lab/InjecAgent:f19c9f2c79a41046eb13c03c51a24c567a8ffa07; do
  IFS=: read d repo sha <<< "$r"; git init -q corpus3/src/$d && git -C corpus3/src/$d fetch -q --depth 1 https://github.com/$repo $sha && git -C corpus3/src/$d checkout -q FETCH_HEAD
done
(cd corpus3 && node build.mjs >/dev/null && node strip-sink.mjs && shasum -a 256 -c corpus3.sha256 corpus3-nosink.sha256)
export RESSAC_WORKTREE=/tmp/ressac-c61
BENCH_TYPED=paste $TSX runner-outflow.mts corpus3/corpus3-nosink.json /tmp/c3-nosink.json && node analyze-blind.mjs c3 corpus3/corpus3-nosink.json /tmp/c3-nosink.json
$TSX runner-outflow.mts corpus2/corpus2.json /tmp/c2.json && node analyze-blind.mjs c2 corpus2/corpus2.json /tmp/c2.json
$TSX runner-outflow.mts corpus1bis.json /tmp/1bis.json && node analyze-outflow.mjs corpus1bis.json /tmp/1bis.json
```

Expected: corpus 3 data only `check 1001` of 1944 (51.5%); corpus 2 `check 7`, `rule3 56` of 398; corpus 1-bis `check 38`, `rule3 88` of 341. Each run takes about a second. On `main` the runner stops (`lastMessage` is gone): it replays 0.1.19's wiring, not today's. `judge` mode also needs the removed judge, `RESSAC_LLAMA_SERVER` and the d1 model, which are not published.

B0, the mutation run, on a clean checkout at the measured commit (about 40 min for all 297; pass ids to run a few):

```sh
git worktree add ../ressac-e94539fb e94539fb && (cd ../ressac-e94539fb && corepack pnpm install --frozen-lockfile)
export RESSAC_WORKTREE=$PWD/../ressac-e94539fb
node bench/security/B0/run.mjs validate          # 297 mutations, 0 problems
node bench/security/B0/run.mjs run K10 L5        # applies, runs the targeted vitest files, restores with git checkout
node bench/security/B0/table.mjs counts
```

`run` updates `B0/results-run.json` and skips ids already in it unless named. Keep `RESSAC_WORKTREE` on a separate checkout: the runner refuses a dirty tree, and its own results file would dirty this one. On `main`, `validate` reports 16 mutations whose code was rewritten by the fixes: the catalogue belongs to `e94539fb`.

B4 and B6 host side, against any checkout (`RESSAC_WORKTREE`, default this repo):

```sh
RESSAC_CONTAINER_PORTS=5300-5319 $TSX bench/security/B4-B6/scripts/b4.mts > /tmp/b4.jsonl   # stderr ends with a TALLY line
$TSX bench/security/B4-B6/scripts/b6.mts > /tmp/b6.jsonl
$TSX bench/security/B4-B6/scripts/b5links.mts
```

On `main` after the fixes, `b4.mts` gives 69 held and 2 `BYPASS`, both 4.1.8 (token switching, the part SECURITY.md states as open); `b6.mts` 14 held, 0 bypass.

B7-B9 unit rows (they overwrite `unit/results/`; `git diff` then shows what moved since 0.1.20). They import this repo, not `RESSAC_WORKTREE`. On `main`, `fetch.test.ts` stops at row G15: it expects the request to the Mac's global IPv6 address to arrive, and the fix now refuses it.

```sh
packages/kernel/node_modules/.bin/vitest run --root bench/security/B7-B9/unit --globals fetch.test.ts design-server.test.ts
apps/firefox/node_modules/.bin/vitest run --root bench/security/B7-B9/unit --globals pure.test.ts ui-address.test.ts site-frames.test.ts
```

**A Mac with a built Ressac** (the Firefox engine built with `surfer`, then `build:ui`; see `apps/firefox/README.md`):
- `B7-B9/e2e/*.e2e.ts`: copy each into `apps/firefox/e2e/`, run it with the e2e config, remove it (steps in `B7-B9/REPORT.md`). Tests marked `PREDICTED RED` were findings at 0.1.20. They were run on 2026-11-22 on the branch that fixed them, and passed there; that run's output was not kept, so rerun them to see it.
- `B7-B9/unit/publish-harness.sh`: needs `RESSAC_ENGINE_OBJ` (a built engine's `obj-aarch64-apple-darwin`) and test MAR archives signed with throwaway keys by the engine's `certutil`, `mar` and `signmar`. The steps that made them were not scripted.

**A Mac that can run the agent VM** (Apple Silicon, the pinned Lima and Podman from `apps/firefox/scripts/vm-tools.sh`, the VM image the app downloads):
- B5 and B6 container side: start `drv.mts` with `BENCH_TMP`, `LIMA_HOME`, `RESSAC_ROOT`, `RESSAC_LIMACTL`, `RESSAC_PODMAN` and `RESSAC_VM_TEMPLATE` pointing into a throwaway folder; then `source env.sh` and run `plant.sh` and `cx.sh` in the container.
- B1-B2: the catalogue says what to try; there is no script to rerun.

**A Tart macOS VM and a signed, notarized DMG:** `vm-trial/README.md`. The DMG we used is not published; build your own with `package` (signing identity and notary profile required).

## Data and licences

Corpus 3 adapts two public benchmarks. Neither dataset is copied here: `corpus3/build.mjs` reads them from clones pinned to these commits.
- **AgentDojo**, <https://github.com/ethz-spylab/agentdojo>, commit `089ed468cf3ed0322acc66b0211f26d9d90dbf60`. MIT License, Copyright (c) 2024 Edoardo Debenedetti, Jie Zhang, Mislav Balunovic, Luca Beurer-Kellner, Marc Fischer, and Florian Tramèr.
- **InjecAgent**, <https://github.com/uiuc-kang-lab/InjecAgent>, commit `f19c9f2c79a41046eb13c03c51a24c567a8ffa07`. MIT License, Copyright (c) 2023 Qiusi Zhan.

What was kept and dropped from each is in `outflow/corpus3/NOTES.md`. Corpora 1, 1-bis and 2 are written by their builders, with invented people and invented data; the web addresses in them are of public sites.

The judge figure of `docs/security-testing.md` (87% of attacks let through) comes from a separate bench of the removed judge. Its runner and models are not published, so that figure cannot be rerun from here.

## Known limits of the bench

- **No end-to-end number.** B3 is not run. Nothing here says how often Ressac leaks under a real injection.
- **One run, one machine, one commit.** Each brick ran once on 0.1.20 (an M5 Pro Mac). The bypasses were fixed after, so a rerun on `main` measures the fixes, not the 0.1.20 numbers.
- **Not every attack ran.** B7-B9's report lists cases pending the engine, a VM or never written (« Not done »). B1-B2's live-race attacks (DNS rebinding, CONNECT fronting) were argued from code. No brick tested the Docker fallback.
- **B0 is first-order and unit-level.** 297 hand-picked mutations are not exhaustive, and 21 guards live only in Firefox: their e2e tests were named, not run.
- **No model acted.** In B4-B6 the fake API answers every model call with an error. The tests show what reaches the model and what the tools allow, not what a steered model would do.
- **The outflow corpora.** Corpus 3 is adapted by a script, not written by attackers. Each leak is sent whole in one gesture, and the item-level intervals are too narrow (28 + 14 distinct leaks, 20 honest goals). Corpus 1's attacks were written by an agent that knew the judge, and five of its misses later fed the sensitive-site list. The runner re-implements `server.ts`'s wiring around the real detectors. No tab got the « shared by you » exemption, so 51.5% is an upper bound.
- **Same family of authors.** Catalogues were written by agents that had not built the brick, but by the same team's tooling. No independent review has seen this bench.
- **Lost records.** B1-B2's runners and B5-B6's container outputs were not kept; their reports are the evidence.
