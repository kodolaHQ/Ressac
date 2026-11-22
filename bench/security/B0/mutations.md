# B0 mutation catalogue

Written before any mutated test run, from the code and SECURITY.md at e94539fb, without reading the tests (their file names only, to pick the targeted files).

Each mutation replaces `find` (one exact occurrence) by `to` in one file, runs the targeted unit tests, and is restored with `git checkout`. « e2e » marks a guard whose wiring only runs inside Firefox: the unit tests are still run, the e2e file is named and not run.

297 mutations.


## packages/kernel/src/mcp/seen.ts

| id | guard | line | find → to | lets through | targeted tests | e2e |
|---|---|---|---|---|---|---|
| A1 | seen.ts exact-address | 26 | `if (!this.urls.has(url)) return false;` → `(removed)` | has() says yes to any address | K:mcp/seen, K:recaps/recaps, K:mcp/server |  |
| A2 | seen.ts fragment rule | 26 | `if (!this.urls.has(url)) return false;` → `if (!this.urls.has(url) && !this.urls.has(withoutHash(url))) return false;` | has() ignores a fragment the agent added (P#<data> free) | K:mcp/seen, K:recaps/recaps, K:mcp/server |  |
| A3 | seen.ts web-only | 7 | ` && /^https?:$/.test(new URL(url).protocol)` → `(removed)` | any scheme is remembered as read | K:mcp/seen, K:recaps/recaps, K:mcp/server |  |
| A4 | seen.ts length cap | 7 | `url.length <= URL_MAX && ` → `(removed)` | addresses over 2000 chars are remembered | K:mcp/seen, K:recaps/recaps, K:mcp/server |  |
| A5 | seen.ts memory bound | 34 | `if (this.urls.size > SEEN_MAX) this.urls.delete(this.urls.values().next().value!);` → `(removed)` | the set grows without bound (memory, not a leak) | K:mcp/seen, K:recaps/recaps, K:mcp/server |  |

## packages/kernel/src/mcp/server.ts

| id | guard | line | find → to | lets through | targeted tests | e2e |
|---|---|---|---|---|---|---|
| B1 | server.ts composed address (outside search) | 706 | `if (isLocal(url) \|\| seen.has(url) \|\| policy.addressGranted(url)) return null;` → `return null;` | any composed address opens without a card | K:mcp/server, K:mcp/history |  |
| B2 | server.ts address card denial | 712 | `if (!yes) return DENIAL_TEXT;` → `(removed)` | a refused address card still opens the address | K:mcp/server, K:mcp/history |  |
| B3 | server.ts links of agent-written pages | 530 | `if (linksFollowable(o)) seen.add(` → `seen.add(` | links of a local page / site app (agent-written) count as read | K:mcp/server, K:mcp/history |  |
| B4 | server.ts navigate link from a local page | 885 | `const refusal = link === undefined \|\| isLocal(o.url) ? await composedRefusal(` → `const refusal = link === undefined ? await composedRefusal(` | a numbered link of the agent's own local page navigates without a card | K:mcp/server, K:mcp/history |  |
| B5 | server.ts site-app navigate, composed address | 878 | `const refusal = await composedRefusal("navigate", url, reason, extra?.signal); ⏎ if (refusal) return text(refusal);` → `(removed)` | a site app navigates to an agent-composed address on its domains without a card | K:mcp/server, K:mcp/history |  |
| B6 | server.ts site-app navigate, domains | 875 | `if (!bridge.siteUrlAllowed?.(o.site, url)) return text(navigationOutsideSite(url), true);` → `(removed)` | the kernel lets a site app be navigated off its domains (browser guard remains) | K:mcp/server, K:mcp/history |  |
| B7 | server.ts search link rule, open_tab | 810 | `const free = sessions.freeAs(cur.tabId, url);` → `const free = url;` | during a search open_tab opens any address without a card | K:mcp/server, K:mcp/history |  |
| B8 | server.ts search link rule, navigate | 854 | `const free = sessions.freeAs(id, url);` → `const free = url;` | the search tab navigates to any address without a card | K:mcp/server, K:mcp/history |  |
| B9 | server.ts search link rule, read_pages | 1038 | `const free = tabId && sessions.freeAs(tabId, u);` → `const free = u;` | read_pages reads any address without a card | K:mcp/server, K:mcp/history |  |
| B10 | server.ts search address card denial | 865 | `if (!yes) return text(DENIAL_TEXT); ⏎ sessions.allow(id, url);` → `sessions.allow(id, url);` | a refused address card during a search still navigates | K:mcp/server, K:mcp/history |  |
| B11 | server.ts http(s) only | 153 | `return ["http:", "https:"].includes(new URL(url).protocol);` → `return !!new URL(url);` | open_tab / navigate accept any scheme (file:, javascript:, about:) | K:mcp/server, K:mcp/history |  |
| B12 | server.ts readable-tab address | 707 | `.some((t) => t.url === url && policy.canRead(t))` → `.some((t) => t.url === url)` | the address of any open tab, even one the agent may not read, is free | K:mcp/server, K:mcp/history |  |
| B13 | server.ts outflow query pause | 986 | `const hit = outflow?.check(key, query);` → `const hit = undefined as ReturnType<NonNullable<typeof outflow>["check"]>;` | a search query is never checked for secrets / read data | K:mcp/server, K:mcp/history |  |
| B14 | server.ts outflow red line | 668 | `return hit ? { danger: OUTFLOW_DANGER(locale(), hit) } : {};` → `return {};` | an address card never shows its red line | K:mcp/server, K:mcp/history |  |
| B15 | server.ts sensitive tab re-ask | 693 | `if (!isSensitive(o.url)) return true;` → `return true;` | a sensitive tab granted earlier is read during a search with no new card | K:mcp/server, K:mcp/history |  |
| B16 | server.ts history re-ask in a search | 1195 | `const had = policy.historyGranted();` → `const had = false;` | history/bookmarks granted earlier are read during a search with no new card | K:mcp/server, K:mcp/history |  |
| B17 | server.ts history card | 1189 | `policy.historyGranted() ⏎ ? Promise.resolve(true)` → `true ⏎ ? Promise.resolve(true)` | history and bookmarks are read with no card at all | K:mcp/server, K:mcp/history |  |
| B18 | server.ts tab read consent | 727 | `if (!(await readAccess(o))) return text(DENIAL_TEXT);` → `(removed)` | read_tab / current_page read any tab with no consent | K:mcp/server, K:mcp/history |  |
| B19 | server.ts grant bound to the site seen | 504 | `return policy.canRead(await tab(o.id)); ⏎ }` → `return true; ⏎ }` | a grant given while the tab changed site is used for the new site | K:mcp/server, K:mcp/history |  |
| B20 | server.ts outflow memory of tab reads | 730 | `if (!exempt(o)) remember(r, siteOf(o.url), linksFollowable(o));` → `(removed)` | what the agent reads in a tab is never remembered (rule 2 blind for tabs) | K:mcp/server, K:mcp/history |  |
| B21 | server.ts shared-tab exemption vs sensitive | 687 | `policy.sharedByUser(o.id, o.url) && !isSensitive(o.url);` → `policy.sharedByUser(o.id, o.url);` | a sensitive tab the user spoke from is not remembered either | K:mcp/server, K:mcp/history |  |
| B22 | MCP bearer token | 1669 | `return received.length === expected.length && timingSafeEqual(received, expected);` → `return true;` | any or no token is accepted | K:mcp/server, K:mcp/history |  |
| B23 | MCP bearer token, constant time | 1669 | `return received.length === expected.length && timingSafeEqual(received, expected);` → `return received.equals(expected);` | comparison no longer constant-time (same answers, timing leak) | K:mcp/server, K:mcp/history |  |
| B24 | MCP server listens on localhost | 1769 | `o.host ?? "127.0.0.1"` → `o.host ?? "0.0.0.0"` | the MCP server listens on every interface by default | K:mcp/server, K:mcp/history |  |
| B25 | server.ts search-tab sensitive page remembered | 608 | `if (isSensitive(now.url)) remember(shown, siteOf(now.url), true);` → `(removed)` | a signed-in sensitive page read on the search tab is not remembered | K:mcp/server, K:mcp/history |  |

## packages/kernel/src/search/sessions.ts

| id | guard | line | find → to | lets through | targeted tests | e2e |
|---|---|---|---|---|---|---|
| C1 | sessions.ts free address | 121 | `if (free.has(x.href)) return x.href;` → `return x.href;` | every address is free during a search | K:search/sessions, K:mcp/server |  |
| C2 | sessions.ts added fragment dropped | 122 | `x.hash = ""; ⏎ return free.has(x.href) ? x.href : undefined;` → `const full = x.href; ⏎ x.hash = ""; ⏎ return free.has(x.href) ? full : undefined;` | a fragment the agent added to a read address is kept (data to the page's script) | K:search/sessions, K:mcp/server |  |

## packages/kernel/src/recaps/recaps.ts

| id | guard | line | find → to | lets through | targeted tests | e2e |
|---|---|---|---|---|---|---|
| D1 | recap links only to read addresses | 133 | `chains.filter((s) => kept.has(s) \|\| p.seen.has(s))` → `chains.filter(() => true)` | a recap may link to any address | K:recaps/recaps, K:mcp/server |  |
| D2 | recap open, allowed set | 119 | `openable(url, httpsOnly) && !!(await allowedSet(id))?.has(url)` → `openable(url, httpsOnly)` | opening from a recap accepts any web address | K:recaps/recaps, K:mcp/server |  |
| D3 | recap open, local addresses | 79 | `return !u.username && !u.password && !localUrl(u.hostname);` → `return !u.username && !u.password;` | a recap link may point to a local address | K:recaps/recaps, K:mcp/server |  |
| D4 | recap open, credentials | 79 | `return !u.username && !u.password && !localUrl(u.hostname);` → `return !localUrl(u.hostname);` | a recap link may carry user:password@ | K:recaps/recaps, K:mcp/server |  |

## packages/kernel/src/outflow/detect.ts

| id | guard | line | find → to | lets through | targeted tests | e2e |
|---|---|---|---|---|---|---|
| E1 | detect.ts findSecrets | 212 | `export function findSecrets(text: string): Secret[] {` → `export function findSecrets(text: string): Secret[] { ⏎ if (text !== undefined) return [];` | no secret is ever found | K:outflow/detect, K:outflow/outflow, K:mcp/server |  |
| E2 | detect.ts decodings | 213 | `const all = [...new Set(decodings(text).map(plain))];` → `const all = [plain(text)];` | a secret in base64, hex or URL-encoding is missed | K:outflow/detect, K:outflow/outflow, K:mcp/server |  |
| E3 | detect.ts Luhn checksum | 81 | `if (shaped && issued(digits) && luhnValid(digits)) {` → `if (shaped && issued(digits)) {` | any issuer-shaped number counts as a card (false pauses; checksum claim) | K:outflow/detect, K:outflow/outflow, K:mcp/server |  |
| E4 | detect.ts cards | 178 | `for (const value of cards(text)) found.push({ kind: "card", value });` → `(removed)` | card numbers are not detected | K:outflow/detect, K:outflow/outflow, K:mcp/server |  |
| E5 | detect.ts IBAN | 179 | `for (const value of ibans(text)) found.push({ kind: "iban", value });` → `(removed)` | IBANs are not detected | K:outflow/detect, K:outflow/outflow, K:mcp/server |  |
| E6 | detect.ts NIR | 182 | `if (nirValid(nir)) found.push({ kind: "nir", value: nir });` → `(removed)` | social security numbers are not detected | K:outflow/detect, K:outflow/outflow, K:mcp/server |  |
| E7 | detect.ts JWT | 177 | `for (const m of text.matchAll(JWT)) found.push({ kind: "jwt", value: m[0] });` → `(removed)` | login tokens (JWT) are not detected | K:outflow/detect, K:outflow/outflow, K:mcp/server |  |
| E8 | detect.ts private key | 176 | `for (const m of text.matchAll(PRIVATE_KEY)) found.push({ kind: "private-key", value: m[0] });` → `(removed)` | private keys are not detected | K:outflow/detect, K:outflow/outflow, K:mcp/server |  |
| E9 | detect.ts API keys | 175 | `for (const m of text.matchAll(API_KEY)) found.push({ kind: "api-key", value: m[0] });` → `(removed)` | access keys are not detected | K:outflow/detect, K:outflow/outflow, K:mcp/server |  |
| E10 | detect.ts random tokens | 215 | `for (const token of all.flatMap(random))` → `for (const token of [] as string[])` | unknown high-entropy tokens are not detected | K:outflow/detect, K:outflow/outflow, K:mcp/server |  |
| E11 | detect.ts NFKC folding | 46 | `export const plain = (s: string) => s.normalize("NFKC").replace(` → `export const plain = (s: string) => s.replace(` | full-width digits / compatibility forms hide a number | K:outflow/detect, K:outflow/outflow, K:mcp/server |  |
| E12 | detect.ts hex decoding | 143 | `(form: string) => form.replace(/[0-9a-fA-F]{16,}/g, (s) => printable(Buffer.from(s, "hex")) ?? s),` → `(removed)` | a hex-encoded secret is missed | K:outflow/detect, K:outflow/outflow, K:mcp/server |  |
| E13 | detect.ts base64 decoding | 141 | `(form: string) => form.replace(/[A-Za-z0-9+/]{16,}={0,2}/g, (s) => printable(Buffer.from(s, "base64")) ?? s), ⏎ (form: string) => form.replace(/[A-Za-z0-9_-]{16,}={0,2}/g, (s) => printable(Buffer.from(s, "base64")) ?? s),` → `(removed)` | a base64-encoded secret is missed | K:outflow/detect, K:outflow/outflow, K:mcp/server |  |
| E14 | detect.ts URL decoding | 154 | `const next = node.url < 3 ?` → `const next = node.url < 0 ?` | a percent-encoded secret is missed | K:outflow/detect, K:outflow/outflow, K:mcp/server |  |
| E15 | detect.ts double encoding | 155 | `if (node.rounds < 2)` → `if (node.rounds < 1)` | a secret encoded twice (base64 of base64, hex of base64) is missed | K:outflow/detect, K:outflow/outflow, K:mcp/server |  |
| E16 | detect.ts mask | 223 | `const n = Math.min(4, Math.floor(value.length / 4));` → `const n = Math.min(4, Math.floor(value.length / 4)); ⏎ if (n >= 0) return value;` | the caught secret is shown whole in the pause / red line | K:outflow/detect, K:outflow/outflow, K:mcp/server |  |
| E17 | detect.ts IBAN checksum | 98 | `if (iban.length === IBAN_LENGTHS.get(iban.slice(0, 2)) && ibanValid(iban)) found.push(iban);` → `if (iban.length === IBAN_LENGTHS.get(iban.slice(0, 2))) found.push(iban);` | any IBAN-shaped string counts (false pauses; checksum claim) | K:outflow/detect, K:outflow/outflow, K:mcp/server |  |
| E18 | detect.ts NIR checksum | 182 | `if (nirValid(nir)) found.push({ kind: "nir", value: nir });` → `found.push({ kind: "nir", value: nir });` | any NIR-shaped number counts (false pauses; checksum claim) | K:outflow/detect, K:outflow/outflow, K:mcp/server |  |

## packages/kernel/src/outflow/outflow.ts

| id | guard | line | find → to | lets through | targeted tests | e2e |
|---|---|---|---|---|---|---|
| F1 | outflow.ts check | 290 | `const w = this.wins.get(win); ⏎ const typedNow` → `const w = this.wins.get(win); ⏎ if (out !== undefined) return undefined; ⏎ const typedNow` | nothing leaving is ever flagged | K:outflow/detect, K:outflow/outflow, K:mcp/server |  |
| F2 | outflow.ts rule 2 (read data coming back) | 300 | `if (!w?.read.size) return undefined;` → `if (w !== null) return undefined;` | read e-mails, phones, numbers, ids are never caught coming back | K:outflow/detect, K:outflow/outflow, K:mcp/server |  |
| F3 | outflow.ts typed text forgotten per conversation | 338 | `w.typedItems.clear(); ⏎ w.typedText = w.buffer = w.carry = "";` → `(removed)` | what the user typed in an earlier conversation stays free to send | K:outflow/detect, K:outflow/outflow, K:mcp/server |  |
| F4 | outflow.ts followable links only from the user's sources | 186 | `const found = Array.isArray(links) ? links : links ? [` → `const found = Array.isArray(links) ? links : text ? [` | an address in a tool output the agent writes becomes a followed link (never flagged) | K:outflow/detect, K:outflow/outflow, K:mcp/server |  |
| F5 | outflow.ts rule 2 through encodings | 313 | `for (const soft of new Set(variants(out).map(softNorm))) {` → `for (const soft of new Set([softNorm(out)])) {` | read data sent back in base64 / hex / URL-encoding is missed | K:outflow/detect, K:outflow/outflow, K:mcp/server |  |
| F6 | outflow.ts rule 2 across path segments | 321 | `if (glued === soft) continue;` → `if (glued !== null) continue;` | read data split across URL path segments is missed | K:outflow/detect, K:outflow/outflow, K:mcp/server |  |
| F7 | outflow.ts e-mails remembered | 102 | `for (const m of text.matchAll(EMAIL)) others.push({ at: m.index, kind: "email", value: m[0] });` → `(removed)` | read e-mail addresses are not remembered | K:outflow/detect, K:outflow/outflow, K:mcp/server |  |
| F8 | outflow.ts phones remembered | 103 | `for (const m of text.matchAll(PHONE)) others.push({ at: m.index, kind: "phone", value: m[0].replace(/\D/g, "") });` → `(removed)` | read phone numbers are not remembered as phones | K:outflow/detect, K:outflow/outflow, K:mcp/server |  |
| F9 | outflow.ts long numbers remembered | 107 | `if (run.replace(/\D/g, "").length >= DIGIT_CHUNK && !DATE.test(run))` → `if (run === null)` | read long numbers are not remembered | K:outflow/detect, K:outflow/outflow, K:mcp/server |  |
| F10 | outflow.ts identifiers remembered | 113 | `if (o.length >= TEXT_CHUNK && /[a-z]/i.test(o) && /\d/.test(o)) others.push({ at: m.index, kind: "token", value: m[0] });` → `(removed)` | read identifiers are not remembered | K:outflow/detect, K:outflow/outflow, K:mcp/server |  |
| F11 | outflow.ts norm NFKC | 94 | `const norm = (s: string) => s.normalize("NFKC").toLowerCase()` → `const norm = (s: string) => s.toLowerCase()` | full-width / compatibility forms dodge the comparison | K:outflow/detect, K:outflow/outflow, K:mcp/server |  |
| F12 | outflow.ts typed exemption scope | 296 | `if (typed(n)) continue;` → `if (w) continue;` | rule 1 exempts every secret once the window has any state | K:outflow/detect, K:outflow/outflow, K:mcp/server |  |
| F13 | outflow.ts whole-address exemption only for addresses | 302 | `if (address && w.urls.has(sameAddress(out) ?? "")) return undefined;` → `if (address) return undefined;` | rule 2 never applies to an address the agent opens | K:outflow/detect, K:outflow/outflow, K:mcp/server |  |

## packages/kernel/src/access/policy.ts

| id | guard | line | find → to | lets through | targeted tests | e2e |
|---|---|---|---|---|---|---|
| G1 | policy.ts canRead | 286 | `return org !== null && this.permissions.get(o.id) === org; ⏎ } ⏎ /** The user shows the agent the data of this widget` → `return true; ⏎ } ⏎ /** The user shows the agent the data of this widget` | every tab is readable | K:access/policy, K:mcp/server, K:mcp/history, K:mcp/devtools, K:mcp/extensions |  |
| G2 | policy.ts one origin per permission | 286 | `return org !== null && this.permissions.get(o.id) === org; ⏎ } ⏎ /** The user shows the agent the data of this widget` → `return org !== null && this.permissions.has(o.id); ⏎ } ⏎ /** The user shows the agent the data of this widget` | a permission holds for the tab whatever its origin | K:access/policy, K:mcp/server, K:mcp/history, K:mcp/devtools, K:mcp/extensions |  |
| G3 | policy.ts site app read by its grant only | 284 | `if (o.site !== undefined) return this.grantedSiteRead(o.site, o.hash);` → `(removed)` | a site app is readable through a tab permission on the same origin | K:access/policy, K:mcp/server, K:mcp/history, K:mcp/devtools, K:mcp/extensions |  |
| G4 | policy.ts allow() never for a site app | 213 | `if (o.site !== undefined) return false;` → `(removed)` | a site app window gets an origin permission | K:access/policy, K:mcp/server, K:mcp/history, K:mcp/devtools, K:mcp/extensions |  |
| G5 | policy.ts user navigation lapses the permission | 262 | `if (this.permissions.get(id) !== org) this.permissions.delete(id);` → `(removed)` | the permission survives the user changing site | K:access/policy, K:mcp/server, K:mcp/history, K:mcp/devtools, K:mcp/extensions |  |
| G6 | policy.ts agent navigation keeps access on the same site only | 247 | `if (org && (org === this.permissions.get(id) \|\| this.qualify(url))) this.permissions.set(id, org);` → `if (org) this.permissions.set(id, org);` | the agent navigates a granted tab to another site and keeps read access | K:access/policy, K:mcp/server, K:mcp/history, K:mcp/devtools, K:mcp/extensions |  |
| G7 | policy.ts tab opened by the agent | 236 | `if (this.qualify(o.url) \|\| (o.app && isLocal(o.url))) this.allow(o);` → `this.allow(o);` | any tab the agent opens is readable at once (Gmail, bank) | K:access/policy, K:mcp/server, K:mcp/history, K:mcp/devtools, K:mcp/extensions |  |
| G8 | policy.ts demo port range | 88 | `return port > 0 && this.portBuilt(port);` → `return port > 0;` | any local port counts as the agent's demo (the user's dev server, an admin page) | K:access/policy, K:mcp/server, K:mcp/history, K:mcp/devtools, K:mcp/extensions |  |
| G9 | policy.ts reset clears permissions | 362 | `this.permissions.clear(); ⏎ this.rights.clear();` → `this.rights.clear();` | tab permissions survive a new conversation | K:access/policy, K:mcp/server, K:mcp/history, K:mcp/devtools, K:mcp/extensions |  |
| G10 | policy.ts reset clears data grants | 367 | `this.widgetsData.clear();` → `(removed)` | history, address and widget grants survive a new conversation | K:access/policy, K:mcp/server, K:mcp/history, K:mcp/devtools, K:mcp/extensions |  |
| G11 | policy.ts reset clears site grants | 368 | `this.sitesRead.clear();` → `(removed)` | site app grants survive a new conversation | K:access/policy, K:mcp/server, K:mcp/history, K:mcp/devtools, K:mcp/extensions |  |
| G12 | policy.ts site grant bound to the declaration hash | 342 | `return this.sitesRead.has(id) && this.sitesRead.get(id) === (hash ?? null);` → `return this.sitesRead.has(id);` | a site app whose declaration changed after the card stays granted | K:access/policy, K:mcp/server, K:mcp/history, K:mcp/devtools, K:mcp/extensions |  |
| G13 | policy.ts dev rights lapse on origin change | 255 | `if (this.rights.get(id)?.origin !== org) this.rights.delete(id);` → `(removed)` | run_js / console rights are kept in memory after the tab changes origin | K:access/policy, K:mcp/server, K:mcp/history, K:mcp/devtools, K:mcp/extensions |  |
| G14 | policy.ts dev rights valid for one origin | 145 | `(grants?.origin === org && grants.list.has(d))` → `(!!grants && grants.list.has(d))` | run_js granted on one origin is valid on any origin of that tab | K:access/policy, K:mcp/server, K:mcp/history, K:mcp/devtools, K:mcp/extensions |  |
| G15 | policy.ts no dev rights on an ungranted site app | 151 | `if (o.site !== undefined && !this.grantedSiteRead(o.site, o.hash)) return [];` → `(removed)` | dev rights on a site app without its grant | K:access/policy, K:mcp/server, K:mcp/history, K:mcp/devtools, K:mcp/extensions |  |
| G16 | policy.ts cut removes read | 185 | `if (!d) this.permissions.delete(id);` → `(removed)` | the user's cut leaves read access | K:access/policy, K:mcp/server, K:mcp/history, K:mcp/devtools, K:mcp/extensions |  |
| G17 | policy.ts opaque origins | 7 | `return o === "null" ? null : o;` → `return o;` | data:, about:blank, file: tabs all share the origin 'null': one grant covers them all | K:access/policy, K:mcp/server, K:mcp/history, K:mcp/devtools, K:mcp/extensions |  |
| G18 | policy.ts site app never 'built' | 121 | `if (!org \|\| o.site !== undefined \|\| !(o.app \|\| this.qualify(o.url))) return;` → `if (!org \|\| !(o.app \|\| this.qualify(o.url))) return;` | a site app served locally gets the default dev rights of a built page | K:access/policy, K:mcp/server, K:mcp/history, K:mcp/devtools, K:mcp/extensions |  |
| G19 | policy.ts deleted site app loses its grant | 350 | `this.sitesRead.delete(id); ⏎ this.siteRemovals` → `this.siteRemovals` | an app recreated with the same id is read without a new card | K:access/policy, K:mcp/server, K:mcp/history, K:mcp/devtools, K:mcp/extensions |  |
| G20 | policy.ts address approved | 326 | `return this.widgetsData.has(`address:${url}`);` → `return true;` | every address counts as approved earlier | K:access/policy, K:mcp/server, K:mcp/history, K:mcp/devtools, K:mcp/extensions |  |
| G21 | policy.ts built mark lapses on origin change | 256 | `if (this.builtTabs.get(id) !== org) this.builtTabs.delete(id);` → `(removed)` | the 'built' mark stays in memory after the tab leaves its origin | K:access/policy, K:mcp/server, K:mcp/history, K:mcp/devtools, K:mcp/extensions |  |

## packages/kernel/src/access/sensitive.ts

| id | guard | line | find → to | lets through | targeted tests | e2e |
|---|---|---|---|---|---|---|
| H1 | sensitive.ts host list | 44 | `if (HOSTS.some((d) => host === d \|\| host.endsWith("." + d))) return true;` → `(removed)` | listed mail / bank / payment hosts are not sensitive | K:access/sensitive, K:mcp/server |  |
| H2 | sensitive.ts subdomains | 44 | `host === d \|\| host.endsWith("." + d)` → `host === d` | a subdomain of a listed host (www.paypal.com) is not sensitive | K:access/sensitive, K:mcp/server |  |
| H3 | sensitive.ts trailing dot | 43 | `const host = u.hostname.toLowerCase().replace(/\.+$/, "");` → `const host = u.hostname.toLowerCase();` | 'mail.google.com.' is not sensitive | K:access/sensitive, K:mcp/server |  |
| H4 | sensitive.ts wrappers | 41 | `if (u.protocol === "view-source:" \|\| u.protocol === "blob:" \|\| reader !== null) return depth >= 3 \|\| isSensitive(reader ?? u.pathname, depth + 1);` → `(removed)` | view-source:, blob: and reader view of a sensitive page are not sensitive | K:access/sensitive, K:mcp/server |  |
| H5 | sensitive.ts nesting fails closed | 41 | `return depth >= 3 \|\| isSensitive(` → `return depth < 3 && isSensitive(` | deep wrapper nesting is judged not sensitive | K:access/sensitive, K:mcp/server |  |
| H6 | sensitive.ts account path segments | 53 | `if (parts.some((p) => SEGMENTS.has(p))) return true;` → `(removed)` | /settings, /account, /login pages are not sensitive | K:access/sensitive, K:mcp/server |  |
| H7 | sensitive.ts webmail on its own host | 46 | `if (/^(?:web)?mail\./.test(host)) return true;` → `(removed)` | mail.* / webmail.* hosts are not sensitive | K:access/sensitive, K:mcp/server |  |
| H8 | sensitive.ts about:logins | 42 | `return /^(logins\|preferences)$/.test(u.pathname.toLowerCase());` → `return false;` | about:logins is not sensitive | K:access/sensitive, K:mcp/server |  |
| H9 | sensitive.ts Slack workspaces | 49 | `if (host.endsWith(".slack.com") && host !== "www.slack.com" && host !== "api.slack.com") return true;` → `(removed)` | Slack workspaces are not sensitive | K:access/sensitive, K:mcp/server |  |
| H10 | sensitive.ts path case | 47 | `const parts = u.pathname.toLowerCase().split("/").filter(Boolean);` → `const parts = u.pathname.split("/").filter(Boolean);` | /Settings or /LOGIN is not sensitive | K:access/sensitive, K:mcp/server |  |
| H11 | sensitive.ts unparsable address | 36 | `  } catch { ⏎ return false; ⏎ } ⏎ // these wrappers` → `  } catch { ⏎ return true; ⏎ } ⏎ // these wrappers` | (reverse) an unreadable address becomes sensitive: checks the fail-open default is pinned | K:access/sensitive, K:mcp/server |  |

## packages/kernel/src/workspace/no-links.ts

| id | guard | line | find → to | lets through | targeted tests | e2e |
|---|---|---|---|---|---|---|
| I1 | no-links.ts linkFree | 12 | `return real === join(r, relative(root, folder));` → `return true;` | a folder reached through a planted symlink is accepted | K:sites/read, K:home/theme, K:design/remarks, K:workflows/edit, K:profiles/config-mcp, K:applications/manifest, K:container/workshop, F:sites-host, F:home-copy-root |  |
| I2 | no-links.ts missing folder | 13 | `  } catch { ⏎ return false;` → `  } catch { ⏎ return true;` | a missing or unreadable folder counts as link-free | K:sites/read, K:home/theme, K:design/remarks, K:workflows/edit, K:profiles/config-mcp, K:applications/manifest, K:container/workshop, F:sites-host, F:home-copy-root |  |

## packages/kernel/src/workspace/confined.ts

| id | guard | line | find → to | lets through | targeted tests | e2e |
|---|---|---|---|---|---|---|
| J1 | confined.ts enter: folder is not a link | 46 | `const l = fs.lstatSync(path); ⏎ if (!l.isDirectory()) throw new Error("not a real folder");` → `const l = fs.statSync(path); ⏎ if (!l.isDirectory()) throw new Error("not a real folder");` | enter() follows a symlinked folder | K:workspace/confined, K:container/instruction-files, K:sites/read, K:home/theme, K:design/remarks, K:workflows/edit, K:profiles/config-mcp, K:applications/manifest, K:container/workshop, F:sites-host, F:home-copy-root |  |
| J2 | confined.ts enter: same inode after chdir | 50 | `if (here.dev !== l.dev \|\| here.ino !== l.ino) throw new Error("folder changed");` → `(removed)` | a folder swapped for a link between lstat and chdir is entered (race) | K:workspace/confined, K:container/instruction-files, K:sites/read, K:home/theme, K:design/remarks, K:workflows/edit, K:profiles/config-mcp, K:applications/manifest, K:container/workshop, F:sites-host, F:home-copy-root |  |
| J3 | confined.ts enter: names | 54 | `if (name === "" \|\| name === "." \|\| name === ".." \|\| name.includes("/")) throw new Error("bad name");` → `(removed)` | '..' or 'a/b' as a folder name walks out | K:workspace/confined, K:container/instruction-files, K:sites/read, K:home/theme, K:design/remarks, K:workflows/edit, K:profiles/config-mcp, K:applications/manifest, K:container/workshop, F:sites-host, F:home-copy-root |  |
| J4 | confined.ts readFiles: path parts | 84 | `if (parts.some((p) => p === "" \|\| p === "." \|\| p === "..")) return "refused";` → `(removed)` | '../x' as a file path reads outside the folder | K:workspace/confined, K:container/instruction-files, K:sites/read, K:home/theme, K:design/remarks, K:workflows/edit, K:profiles/config-mcp, K:applications/manifest, K:container/workshop, F:sites-host, F:home-copy-root |  |
| J5 | confined.ts readFiles: intermediate folder is not a link | 87 | `const l = fs.lstatSync(part, { throwIfNoEntry: false });` → `const l = fs.statSync(part, { throwIfNoEntry: false });` | a symlinked sub-folder is followed on the way to a file | K:workspace/confined, K:container/instruction-files, K:sites/read, K:home/theme, K:design/remarks, K:workflows/edit, K:profiles/config-mcp, K:applications/manifest, K:container/workshop, F:sites-host, F:home-copy-root |  |
| J6 | confined.ts readFiles: file is not a link (lstat) | 93 | `const l = fs.lstatSync(name, { throwIfNoEntry: false }); ⏎ if (!l) return "absent"; ⏎ if (!l.isFile()) return "refused";` → `const l = fs.statSync(name, { throwIfNoEntry: false }); ⏎ if (!l) return "absent"; ⏎ if (!l.isFile()) return "refused";` | lstat check on the file gone (O_NOFOLLOW still there) | K:workspace/confined, K:container/instruction-files, K:sites/read, K:home/theme, K:design/remarks, K:workflows/edit, K:profiles/config-mcp, K:applications/manifest, K:container/workshop, F:sites-host, F:home-copy-root |  |
| J7 | confined.ts readFiles: O_NOFOLLOW | 97 | `fs.openSync(name, O_RDONLY \| O_NOFOLLOW \| O_NONBLOCK)` → `fs.openSync(name, O_RDONLY \| O_NONBLOCK)` | a file swapped for a link after lstat is followed (race) | K:workspace/confined, K:container/instruction-files, K:sites/read, K:home/theme, K:design/remarks, K:workflows/edit, K:profiles/config-mcp, K:applications/manifest, K:container/workshop, F:sites-host, F:home-copy-root |  |
| J8 | confined.ts readFiles: link file (both checks) | 93 | `const l = fs.lstatSync(name, { throwIfNoEntry: false }); ⏎ if (!l) return "absent"; ⏎ if (!l.isFile()) return "refused"; ⏎ if (l.size > max) return "big"; ⏎ const fd = fs.openSync(name, O_RDONLY \| O_NOFOLLOW \| O_NONBLOCK);` → `const l = fs.statSync(name, { throwIfNoEntry: false }); ⏎ if (!l) return "absent"; ⏎ if (!l.isFile()) return "refused"; ⏎ if (l.size > max) return "big"; ⏎ const fd = fs.openSync(name, O_RDONLY \| O_NONBLOCK);` | a symlinked file is read (/etc/passwd, ~/.ssh) | K:workspace/confined, K:container/instruction-files, K:sites/read, K:home/theme, K:design/remarks, K:workflows/edit, K:profiles/config-mcp, K:applications/manifest, K:container/workshop, F:sites-host, F:home-copy-root |  |
| J9 | confined.ts writeEntries: temp O_EXCL\|O_NOFOLLOW | 146 | `fs.openSync(temp, O_WRONLY \| O_CREAT \| O_EXCL \| O_NOFOLLOW, 0o666)` → `fs.openSync(temp, O_WRONLY \| O_CREAT, 0o666)` | a pre-planted link at the temp name is written through (needs guessing 4 random bytes) | K:workspace/confined, K:container/instruction-files, K:sites/read, K:home/theme, K:design/remarks, K:workflows/edit, K:profiles/config-mcp, K:applications/manifest, K:container/workshop, F:sites-host, F:home-copy-root |  |
| J10 | confined.ts moveEntry: parent is not a link | 172 | `const p = fs.lstatSync(parent);` → `const p = fs.statSync(parent);` | moveEntry works through a symlinked parent | K:workspace/confined, K:container/instruction-files, K:sites/read, K:home/theme, K:design/remarks, K:workflows/edit, K:profiles/config-mcp, K:applications/manifest, K:container/workshop, F:sites-host, F:home-copy-root |  |
| J11 | confined.ts moveEntry: entry is a real folder | 178 | `if (!fs.lstatSync(name).isDirectory()) return "refused";` → `(removed)` | moveEntry renames a link or a file | K:workspace/confined, K:container/instruction-files, K:sites/read, K:home/theme, K:design/remarks, K:workflows/edit, K:profiles/config-mcp, K:applications/manifest, K:container/workshop, F:sites-host, F:home-copy-root |  |
| J12 | confined.ts readFiles: size cap | 96 | `if (l.size > max) return "big";` → `(removed)` | (the read loop still caps at max+1) lstat size check gone | K:workspace/confined, K:container/instruction-files, K:sites/read, K:home/theme, K:design/remarks, K:workflows/edit, K:profiles/config-mcp, K:applications/manifest, K:container/workshop, F:sites-host, F:home-copy-root |  |
| J13 | confined.ts readFiles: grown file refused | 105 | `if (size > max \|\| (total += size) > totalMax) return "big";` → `if ((total += size) > totalMax) return "big";` | a file that grew past max since lstat is cut, not refused | K:workspace/confined, K:container/instruction-files, K:sites/read, K:home/theme, K:design/remarks, K:workflows/edit, K:profiles/config-mcp, K:applications/manifest, K:container/workshop, F:sites-host, F:home-copy-root |  |

## packages/kernel/docker/ressac-network.mjs

| id | guard | line | find → to | lets through | targeted tests | e2e |
|---|---|---|---|---|---|---|
| K1 | network: allowlist match | 33 | `return domains.some((d) => (d.startsWith("*.") ? h.endsWith(d.slice(1)) && h.length > d.length - 1 : h === d));` → `return true;` | the proxy lets every host through | K:container/network-module, K:container/workshop |  |
| K2 | network: wildcard needs the dot | 33 | `h.endsWith(d.slice(1))` → `h.endsWith(d.slice(2))` | '*.example.com' also matches evilexample.com | K:container/network-module, K:container/workshop |  |
| K3 | network: exact host match | 33 | ` : h === d));` → ` : h.endsWith(d)));` | 'github.com' also matches evilgithub.com | K:container/network-module, K:container/workshop |  |
| K4 | network: iptables tcp reject | 48 | `"-A OUTPUT -p tcp -j REJECT --reject-with tcp-reset",` → `(removed)` | (final REJECT remains) tcp-reset line gone | K:container/network-module, K:container/workshop |  |
| K5 | network: iptables final reject | 49 | `"-A OUTPUT -j REJECT",` → `(removed)` | ICMP and other protocols leave the container | K:container/network-module, K:container/workshop |  |
| K6 | network: iptables udp reject | 47 | `"-A OUTPUT -p udp -j REJECT --reject-with icmp-port-unreachable",` → `(removed)` | (final REJECT remains) udp line gone | K:container/network-module, K:container/workshop |  |
| K7 | network: Mac reachable on given ports only | 46 | `/32 -p tcp --dport ` → `/32 -m comment --comment ` | every port of the Mac is reachable from the container | K:container/network-module, K:container/workshop |  |
| K8 | network: all three rejects | 47 | `"-A OUTPUT -p udp -j REJECT --reject-with icmp-port-unreachable", ⏎ "-A OUTPUT -p tcp -j REJECT --reject-with tcp-reset", ⏎ "-A OUTPUT -j REJECT",` → `(removed)` | the container's outbound network is fully open | K:container/network-module, K:container/workshop |  |
| K9 | network: proxy refuses private addresses | 77 | `if (list.some((a) => localAddress(a.address, a.family))) return cb(` → `if (list.length < 0) return cb(` | an allowed name resolving to the Mac / LAN / router is connected to | K:container/network-module, K:container/workshop |  |
| K10 | network: 192.168/16 private | 59 | `, ["192.168.0.0", 16]` → `(removed)` | 192.168.x.x is not private for the proxy | K:container/network-module, K:container/workshop |  |
| K11 | network: 169.254/16 link-local | 59 | `["169.254.0.0", 16], ` → `(removed)` | link-local (cloud metadata) is not private for the proxy | K:container/network-module, K:container/workshop |  |
| K12 | network: 100.64/10 CGNAT | 59 | `["100.64.0.0", 10], ` → `(removed)` | 100.64.x.x (Tailscale, CGNAT) is not private for the proxy | K:container/network-module, K:container/workshop |  |
| K13 | network: IPv4-mapped IPv6 | 65 | `if (v4) return LOCAL.check(v4[1], "ipv4");` → `(removed)` | ::ffff:127.0.0.1 is not private for the proxy | K:container/network-module, K:container/workshop |  |
| K14 | network: IPv6 unique-local | 60 | `["fc00::", 7], ` → `(removed)` | fc00::/7 is not private for the proxy | K:container/network-module, K:container/workshop |  |
| K15 | network: CONNECT ports | 113 | `if (!m \|\| !ports.includes(port) \|\| !allowed(m[1], getDomains())) {` → `if (!m \|\| !allowed(m[1], getDomains())) {` | CONNECT to any port of an allowed host (ssh on github.com:22) | K:container/network-module, K:container/workshop |  |
| K16 | network: CONNECT host check | 113 | `if (!m \|\| !ports.includes(port) \|\| !allowed(m[1], getDomains())) {` → `if (!m \|\| !ports.includes(port)) {` | CONNECT to any host on 443/80 | K:container/network-module, K:container/workshop |  |
| K17 | network: plain HTTP host check | 93 | `Number(url.port \|\| 80) !== httpPort \|\| !allowed(url.hostname, getDomains())) {` → `Number(url.port \|\| 80) !== httpPort) {` | plain HTTP to any host | K:container/network-module, K:container/workshop |  |
| K18 | network: plain HTTP port check | 93 | `url.protocol !== "http:" \|\| Number(url.port \|\| 80) !== httpPort \|\| ` → `url.protocol !== "http:" \|\| ` | (the request still goes to httpPort) port check on the asked URL gone | K:container/network-module, K:container/workshop |  |
| K19 | network: domain syntax, IP literal | 28 | ` && !/^[0-9.]+$/.test(name)` → `(removed)` | an IP address is accepted as an allowed 'domain' | K:container/network-module, K:container/workshop |  |
| K20 | network: domain syntax, two labels | 28 | `labels.length >= 2 && ` → `(removed)` | '*.com' or 'localhost' is accepted as an allowed domain | K:container/network-module, K:container/workshop |  |
| K21 | network: guarded lookup is the default | 82 | `localOk = false } = {}` → `localOk = true } = {}` | the real proxy runs without the private-address check | K:container/network-module, K:container/workshop |  |
| K22 | network: 127/8 and 10/8 | 59 | `["10.0.0.0", 8], ` → `(removed)` | 10.x.x.x is not private for the proxy | K:container/network-module, K:container/workshop |  |
| K23 | network: trailing dot / case of the asked host | 32 | `const h = String(host).toLowerCase().replace(/\.$/, "");` → `const h = String(host);` | (reverse: stricter) 'GitHub.com.' no longer matches; checks normalisation is pinned | K:container/network-module, K:container/workshop |  |

## packages/kernel/src/workflows/access.ts

| id | guard | line | find → to | lets through | targeted tests | e2e |
|---|---|---|---|---|---|---|
| L1 | access.ts localUrl 127/8 | 38 | `a === 0 \|\| a === 10 \|\| a === 127 \|\| ` → `a === 0 \|\| a === 10 \|\| ` | 127.x.x.x is not local | K:workflows/run, K:workflows/blocks, K:workflows/interpreter, K:sites/urls, K:recaps/recaps, K:widgets/harvest, F:local-guard, F:page-guard, F:sites/navigation |  |
| L2 | access.ts localUrl 10/8 | 38 | `a === 0 \|\| a === 10 \|\| a === 127 \|\| ` → `a === 0 \|\| a === 127 \|\| ` | 10.x.x.x is not local | K:workflows/run, K:workflows/blocks, K:workflows/interpreter, K:sites/urls, K:recaps/recaps, K:widgets/harvest, F:local-guard, F:page-guard, F:sites/navigation |  |
| L3 | access.ts localUrl 169.254/16 | 38 | `(a === 169 && b === 254) \|\| ` → `(removed)` | 169.254.x.x (cloud metadata) is not local | K:workflows/run, K:workflows/blocks, K:workflows/interpreter, K:sites/urls, K:recaps/recaps, K:widgets/harvest, F:local-guard, F:page-guard, F:sites/navigation |  |
| L4 | access.ts localUrl 172.16/12 | 38 | `(a === 172 && b >= 16 && b <= 31) \|\|` → `(removed)` | 172.16-31.x.x is not local | K:workflows/run, K:workflows/blocks, K:workflows/interpreter, K:sites/urls, K:recaps/recaps, K:widgets/harvest, F:local-guard, F:page-guard, F:sites/navigation |  |
| L5 | access.ts localUrl 192.168/16 | 39 | `(a === 192 && b === 168) \|\| ` → `(removed)` | 192.168.x.x is not local | K:workflows/run, K:workflows/blocks, K:workflows/interpreter, K:sites/urls, K:recaps/recaps, K:widgets/harvest, F:local-guard, F:page-guard, F:sites/navigation |  |
| L6 | access.ts localUrl 100.64/10 | 39 | `(a === 100 && b >= 64 && b <= 127) \|\| ` → `(removed)` | 100.64.x.x is not local | K:workflows/run, K:workflows/blocks, K:workflows/interpreter, K:sites/urls, K:recaps/recaps, K:widgets/harvest, F:local-guard, F:page-guard, F:sites/navigation |  |
| L7 | access.ts localUrl multicast / reserved | 39 | `(a === 100 && b >= 64 && b <= 127) \|\| a >= 224;` → `(a === 100 && b >= 64 && b <= 127);` | 224.0.0.0 and above are not local | K:workflows/run, K:workflows/blocks, K:workflows/interpreter, K:sites/urls, K:recaps/recaps, K:widgets/harvest, F:local-guard, F:page-guard, F:sites/navigation |  |
| L8 | access.ts localUrl 0/8 | 38 | `return a === 0 \|\| a === 10` → `return a === 10` | 0.0.0.0 is not local | K:workflows/run, K:workflows/blocks, K:workflows/interpreter, K:sites/urls, K:recaps/recaps, K:widgets/harvest, F:local-guard, F:page-guard, F:sites/navigation |  |
| L9 | access.ts localUrl IPv4-mapped IPv6 | 42 | ` \|\| h.startsWith("::ffff:")` → `(removed)` | [::ffff:127.0.0.1] is not local | K:workflows/run, K:workflows/blocks, K:workflows/interpreter, K:sites/urls, K:recaps/recaps, K:widgets/harvest, F:local-guard, F:page-guard, F:sites/navigation |  |
| L10 | access.ts localUrl NAT64 | 42 | ` \|\| h.startsWith("64:ff9b:")` → `(removed)` | 64:ff9b:: (NAT64 of an IPv4) is not local | K:workflows/run, K:workflows/blocks, K:workflows/interpreter, K:sites/urls, K:recaps/recaps, K:widgets/harvest, F:local-guard, F:page-guard, F:sites/navigation |  |
| L11 | access.ts localUrl IPv6 unique-local | 42 | ` \|\| /^f[cd]/.test(h)` → `(removed)` | fc00::/7 is not local | K:workflows/run, K:workflows/blocks, K:workflows/interpreter, K:sites/urls, K:recaps/recaps, K:widgets/harvest, F:local-guard, F:page-guard, F:sites/navigation |  |
| L12 | access.ts localUrl IPv6 link-local | 42 | ` \|\| /^fe[89ab]/.test(h)` → `(removed)` | fe80::/10 is not local | K:workflows/run, K:workflows/blocks, K:workflows/interpreter, K:sites/urls, K:recaps/recaps, K:widgets/harvest, F:local-guard, F:page-guard, F:sites/navigation |  |
| L13 | access.ts localUrl ::1 | 42 | `return h === "::" \|\| h === "::1" \|\| ` → `return h === "::" \|\| ` | [::1] is not local | K:workflows/run, K:workflows/blocks, K:workflows/interpreter, K:sites/urls, K:recaps/recaps, K:widgets/harvest, F:local-guard, F:page-guard, F:sites/navigation |  |
| L14 | access.ts localUrl trailing dot | 34 | `const h = host.replace(/^\[\|\]$/g, "").toLowerCase().replace(/(?<!\.)\.+$/, "");` → `const h = host.replace(/^\[\|\]$/g, "").toLowerCase();` | 'localhost.' is not local | K:workflows/run, K:workflows/blocks, K:workflows/interpreter, K:sites/urls, K:recaps/recaps, K:widgets/harvest, F:local-guard, F:page-guard, F:sites/navigation |  |
| L15 | access.ts localUrl local names | 35 | `/\.(localhost\|local\|internal\|home\.arpa)$/` → `/\.(localhost)$/` | x.local, x.internal, x.home.arpa are not local | K:workflows/run, K:workflows/blocks, K:workflows/interpreter, K:sites/urls, K:recaps/recaps, K:widgets/harvest, F:local-guard, F:page-guard, F:sites/navigation |  |
| L16 | access.ts localUrl localhost | 35 | `if (!h \|\| h === "localhost" \|\| ` → `if (!h \|\| ` | localhost is not local | K:workflows/run, K:workflows/blocks, K:workflows/interpreter, K:sites/urls, K:recaps/recaps, K:widgets/harvest, F:local-guard, F:page-guard, F:sites/navigation |  |
| L17 | access.ts localUrl case | 34 | `const h = host.replace(/^\[\|\]$/g, "").toLowerCase().replace(` → `const h = host.replace(/^\[\|\]$/g, "").replace(` | 'LOCALHOST' is not local (when the caller did not lowercase) | K:workflows/run, K:workflows/blocks, K:workflows/interpreter, K:sites/urls, K:recaps/recaps, K:widgets/harvest, F:local-guard, F:page-guard, F:sites/navigation |  |
| L18 | access.ts checkUrl http(s) only | 58 | `if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("Seules les URL http(s) sont permises");` → `(removed)` | file:, ftp:, data: accepted by the URL check | K:workflows/run, K:workflows/blocks, K:workflows/interpreter, K:sites/urls, K:recaps/recaps, K:widgets/harvest, F:local-guard, F:page-guard, F:sites/navigation |  |
| L19 | access.ts checkUrl no credentials | 59 | `if (u.username \|\| u.password) throw new Error("URL avec identifiants refusée");` → `(removed)` | user:password@ addresses accepted | K:workflows/run, K:workflows/blocks, K:workflows/interpreter, K:sites/urls, K:recaps/recaps, K:widgets/harvest, F:local-guard, F:page-guard, F:sites/navigation |  |
| L20 | access.ts checkUrl declared domains | 62 | `if (domains && !domains.includes(host)) throw` → `if (domains && domains.length < 0) throw` | a widget fetches any domain, declared or not | K:workflows/run, K:workflows/blocks, K:workflows/interpreter, K:sites/urls, K:recaps/recaps, K:widgets/harvest, F:local-guard, F:page-guard, F:sites/navigation |  |
| L21 | access.ts checkUrl local refused | 63 | `if (!localUrls && localUrl(host)) throw` → `if (!localUrls && !host) throw` | a widget fetches local addresses by literal | K:workflows/run, K:workflows/blocks, K:workflows/interpreter, K:sites/urls, K:recaps/recaps, K:widgets/harvest, F:local-guard, F:page-guard, F:sites/navigation |  |
| L22 | access.ts lookup refuses a local resolution | 75 | `if (locale) return callback(new Error(` → `if (locale && !host) return callback(new Error(` | a public name resolving to 127.0.0.1 (rebinding) is fetched | K:workflows/run, K:workflows/blocks, K:workflows/interpreter, K:sites/urls, K:recaps/recaps, K:widgets/harvest, F:local-guard, F:page-guard, F:sites/navigation |  |
| L23 | access.ts lookup: any local address refuses | 74 | `const locale = urls.find((a) => localUrl(a.address));` → `const locale = urls.slice(0, 1).find((a) => localUrl(a.address));` | a name with one public and one local address passes | K:workflows/run, K:workflows/blocks, K:workflows/interpreter, K:sites/urls, K:recaps/recaps, K:widgets/harvest, F:local-guard, F:page-guard, F:sites/navigation |  |
| L24 | access.ts fetch uses the guarded lookup | 86 | `...(localUrls ? {} : { lookup: lookupWithoutLocal })` → `...{}` | the fetch connects without the resolution check | K:workflows/run, K:workflows/blocks, K:workflows/interpreter, K:sites/urls, K:recaps/recaps, K:widgets/harvest, F:local-guard, F:page-guard, F:sites/navigation |  |
| L25 | access.ts redirects re-checked | 143 | `const next = checkUrl(new URL(target, url).href, domains, localUrls);` → `const next = new URL(target, url);` | a redirect leads to an undeclared domain or a local literal | K:workflows/run, K:workflows/blocks, K:workflows/interpreter, K:sites/urls, K:recaps/recaps, K:widgets/harvest, F:local-guard, F:page-guard, F:sites/navigation |  |
| L26 | access.ts redirect cap | 142 | `if (redirections >= MAX_REDIRECTIONS) throw new Error("Trop de redirections");` → `if (redirections >= 50) throw new Error("Trop de redirections");` | 50 redirects followed instead of 5 | K:workflows/run, K:workflows/blocks, K:workflows/interpreter, K:sites/urls, K:recaps/recaps, K:widgets/harvest, F:local-guard, F:page-guard, F:sites/navigation |  |
| L27 | access.ts size cap (stream) | 100 | `if (size > FETCH_MAX_BYTES) {` → `if (size < 0) {` | a response of any size is buffered (when no content-length) | K:workflows/run, K:workflows/blocks, K:workflows/interpreter, K:sites/urls, K:recaps/recaps, K:widgets/harvest, F:local-guard, F:page-guard, F:sites/navigation |  |
| L28 | access.ts size cap (content-length) | 92 | `if (Number(r.headers["content-length"]) > FETCH_MAX_BYTES) {` → `if (Number(r.headers["content-length"]) < 0) {` | (stream cap remains) content-length early refusal gone | K:workflows/run, K:workflows/blocks, K:workflows/interpreter, K:sites/urls, K:recaps/recaps, K:widgets/harvest, F:local-guard, F:page-guard, F:sites/navigation |  |
| L29 | access.ts page final address re-checked | 171 | `checkUrl(String(page?.url), domains, localUrls);` → `(removed)` | a page read that ended off the declared domains gives its text | K:workflows/run, K:workflows/blocks, K:workflows/interpreter, K:sites/urls, K:recaps/recaps, K:widgets/harvest, F:local-guard, F:page-guard, F:sites/navigation |  |

## packages/kernel/src/workflows/run.ts

| id | guard | line | find → to | lets through | targeted tests | e2e |
|---|---|---|---|---|---|---|
| L30 | run.ts open reads cap (100) | 460 | `if (openReads >= MAX_OPEN_READS) throw new Error(TOO_MANY_READS);` → `(removed)` | no cap on open web reads per run | K:workflows/run, K:workflows/interpreter, K:widgets/harvest |  |

## packages/kernel/src/design/external-server.ts

| id | guard | line | find → to | lets through | targeted tests | e2e |
|---|---|---|---|---|---|---|
| M1 | external-server: Origin refused | 174 | `if (req.headers.origin !== undefined) return res.writeHead(403).end();` → `(removed)` | a web page (with its Origin) may call the server | K:design/external-server, K:design/external |  |
| M2 | external-server: Host check | 176 | `if (host !== `127.0.0.1:${realPort}` && host !== `localhost:${realPort}`) return res.writeHead(403).end();` → `(removed)` | DNS rebinding: any Host header accepted | K:design/external-server, K:design/external |  |

## packages/kernel/src/design/external.ts

| id | guard | line | find → to | lets through | targeted tests | e2e |
|---|---|---|---|---|---|---|
| M3 | external-server: per-client token | 107 | `if (other.length === hash.length && timingSafeEqual(other, hash)) found = c;` → `found = c;` | any token names a client | K:design/external-server, K:design/external |  |
| M4 | external-server: token constant time | 107 | `if (other.length === hash.length && timingSafeEqual(other, hash)) found = c;` → `if (other.equals(hash)) found = c;` | comparison no longer constant-time (same answers) | K:design/external-server, K:design/external |  |

## packages/kernel/src/design/external-server.ts

| id | guard | line | find → to | lets through | targeted tests | e2e |
|---|---|---|---|---|---|---|
| M5 | external-server: listens on localhost | 199 | `http.listen(o.port, "127.0.0.1", ok);` → `http.listen(o.port, "0.0.0.0", ok);` | the server listens on every interface | K:design/external-server, K:design/external |  |
| M6 | external-server: capture file name | 54 | `if (e.type === "design" && e.capture && CAPTURE_NAME.test(e.capture)) {` → `if (e.type === "design" && e.capture) {` | a capture name like ../../x.png is read from disk | K:design/external-server, K:design/external |  |
| M7 | external-server: a token is required | 178 | `const client = token ? o.registry.tokenClient(token) : null;` → `const client = (token ? o.registry.tokenClient(token) : null) ?? ({ id: "x", name: "x", hash: "", created: "" } as ExternalClient);` | a request with no or a wrong token is served as a made-up client | K:design/external-server, K:design/external |  |

## packages/kernel/src/workspace/instructions.ts

| id | guard | line | find → to | lets through | targeted tests | e2e |
|---|---|---|---|---|---|---|
| N1 | instructions: changes are reported | 136 | `if (now === before) continue;` → `if (now === before \|\| path) continue;` | no change to AGENTS.md / guides / Codex files is ever reported | K:workspace/instructions, K:kernel, K:container/instruction-files, F:instruction-review |  |
| N2 | instructions: Codex's own config lines | 68 | `=> !!lines && lines.every((l) => l.kind === " " \|\| CODEX_OWN_LINE.test(l.text));` → `=> !!lines;` | any config.toml change (model_instructions_file, mcp_servers, notify) is taken in silently | K:workspace/instructions, K:kernel, K:container/instruction-files, F:instruction-review |  |
| N3 | instructions: own-line pattern excludes model_instructions_file | 67 | `\|trust_level\|model\|model_reasoning_effort)` → `\|trust_level\|model\|model_instructions_file\|model_reasoning_effort)` | config.toml naming an instruction file is taken in silently | K:workspace/instructions, K:kernel, K:container/instruction-files, F:instruction-review |  |
| N4 | instructions: config.toml watched | 28 | `"/home/node/.codex/AGENTS.override.md", CODEX_CONFIG],` → `"/home/node/.codex/AGENTS.override.md"],` | Codex's config.toml is not watched | K:workspace/instructions, K:kernel, K:container/instruction-files, F:instruction-review |  |
| N5 | instructions: AGENTS.override.md watched | 28 | `"/workspace/AGENTS.override.md", ` → `(removed)` | the workspace AGENTS.override.md is not watched | K:workspace/instructions, K:kernel, K:container/instruction-files, F:instruction-review |  |
| N6 | instructions: skill folders watched | 29 | `trees: ["/workspace/.agents/skills", "/workspace/.codex", "/home/node/.codex/skills", "/home/node/.agents/skills"],` → `trees: [],` | skill folders and the project .codex are not watched | K:workspace/instructions, K:kernel, K:container/instruction-files, F:instruction-review |  |
| N7 | instructions: system skills accepted once only | 131 | `if (!(CODEX_SYSTEM_SEEN in ref))` → `if (ref)` | anything planted under ~/.codex/skills/.system is accepted silently at every session | K:workspace/instructions, K:kernel, K:container/instruction-files, F:instruction-review |  |
| N8 | instructions: accepted AGENTS.md never a marker | 190 | `accepted === undefined \|\| isMarker(accepted) ? "" : accepted` → `accepted ?? ""` | a marker (link target, too-long…) is written as Claude's AGENTS.md | K:workspace/instructions, K:kernel, K:container/instruction-files, F:instruction-review |  |
| N9 | instructions: guides watched | 20 | `const TEXTS = ["AGENTS.md", "guides/widgets.md", "guides/extensions.md", "guides/actions.md", "guides/site-apps.md"];` → `const TEXTS = ["AGENTS.md"];` | the four guides are not watched | K:workspace/instructions, K:kernel, K:container/instruction-files, F:instruction-review |  |

## packages/kernel/src/kernel.ts

| id | guard | line | find → to | lets through | targeted tests | e2e |
|---|---|---|---|---|---|---|
| N10 | kernel.ts gate: a change stops the start | 727 | `if (changes.length === 0) break;` → `if (changes.length >= 0) break;` | the session starts whatever changed, no card | K:workspace/instructions, K:kernel, K:container/instruction-files, F:instruction-review |  |
| N11 | kernel.ts gate: no reviewer / 3 rounds refuses | 728 | `if (!review \|\| round === 3) throw new Error(say(loc(), "kernel-err-instructions-changed"));` → `if (!review \|\| round === 3) break;` | with no card available, or after 3 rounds, the session starts on unaccepted files | K:workspace/instructions, K:kernel, K:container/instruction-files, F:instruction-review |  |
| N12 | kernel.ts gate: Claude reads the accepted copy | 732 | `if (kind === "claude") await instructions.acceptedAgents();` → `(removed)` | the accepted AGENTS.md copy is not refreshed before a Claude session | K:workspace/instructions, K:kernel, K:container/instruction-files, F:instruction-review |  |
| N13 | kernel.ts gate: Navigateur for both CLIs | 724 | `const kind = browser && (program === "claude" \|\| program === "codex") ? program : null;` → `const kind = browser && program === "claude" ? program : null;` | Codex sessions in Navigateur skip the gate | K:workspace/instructions, K:kernel, K:container/instruction-files, F:instruction-review |  |
| N14 | kernel.ts gate: revert on refusal | 730 | `else await instructions.revert(kind, snapshot);` → `else await instructions.keep(kind, snapshot);` | « Revenir » keeps the agent's change | K:workspace/instructions, K:kernel, K:container/instruction-files, F:instruction-review |  |

## apps/firefox/shared/telemetry.ts

| id | guard | line | find → to | lets through | targeted tests | e2e |
|---|---|---|---|---|---|---|
| O1 | telemetry: addresses scrubbed | 21 | `const t = text.replace(PRIVATE_URL, "<url>");` → `const t = text;` | web addresses leave in error reports | F:telemetry |  |
| O2 | telemetry: home path scrubbed | 24 | `return h ? t.replace(` → `return h && !h ? t.replace(` | the home path (user name) leaves in error reports | F:telemetry |  |
| O3 | telemetry: quoted spans dropped | 57 | `.replace(QUOTED, '"…"')` → `(removed)` | quoted text in an error message leaves | F:telemetry |  |
| O4 | telemetry: stack frames scrubbed | 45 | `.map((f) => ({ ...f, filename: s(f.filename), function: s(f.function) }))` → `(removed)` | paths and addresses in stack frames leave unscrubbed | F:telemetry |  |
| O5 | telemetry: reports off means nothing sent | 76 | `if (!urls \|\| !o.enabled() \|\| seen.size >= max) return;` → `if (!urls \|\| seen.size >= max) return;` | error reports are sent with the switch off | F:telemetry |  |
| O6 | telemetry: launch count off means nothing sent | 113 | `if (!o.enabled()) return o.ids.clear();` → `(removed)` | the launch count is sent with the switch off | F:telemetry |  |
| O7 | telemetry: file:// scrubbed | 18 | `(?:https?\|wss?\|file):` → `(?:https?\|wss?):` | file:// paths leave in error reports | F:telemetry |  |
| O8 | telemetry: blob:/data: scrubbed | 18 | `\|blob:\|data:)` → `)` | blob: and data: addresses leave in error reports | F:telemetry |  |
| O9 | telemetry: no IP inference | 53 | `settings: { infer_ip: "never" }` → `settings: {}` | (explicit 0.0.0.0 remains) infer_ip never gone | F:telemetry |  |
| O10 | telemetry: unlocatable IP | 55 | `user: { ip_address: "0.0.0.0" },` → `user: {},` | (infer_ip never remains) explicit IP gone from error events | F:telemetry |  |
| O11 | telemetry: error type scrubbed | 57 | `type: s(e.type), value: s(e.message)` → `type: e.type, value: s(e.message)` | an address or path in the error type leaves | F:telemetry |  |
| O12 | telemetry: message capped at 300 | 57 | `.slice(0, 300)` → `(removed)` | a long error message leaves whole | F:telemetry |  |
| O13 | telemetry: home path boundary | 24 | `"(?![\\w.-])"` → `""` | /Users/marieX is rewritten as ~X (over-scrub, not a leak) | F:telemetry |  |
| O14 | telemetry: session IP | 95 | `attrs: { release: o.release, environment: "beta", ip_address: "0.0.0.0" },` → `attrs: { release: o.release, environment: "beta" },` | the launch count lets Sentry derive a city from the IP | F:telemetry |  |

## apps/firefox/chrome/store/telemetry.ts

| id | guard | line | find → to | lets through | targeted tests | e2e |
|---|---|---|---|---|---|---|
| O15 | telemetry: nothing before the notice | 21 | `const consented = () => enabled() && Services.prefs.getBoolPref(NOTICE_SHOWN, false);` → `const consented = () => enabled();` | reports and the launch count leave before the notice has shown | F:telemetry | e2e/telemetry.e2e.ts |
| O16 | telemetry: crash reports need their own switch | 33 | `const on = active && consented() && Services.prefs.getBoolPref(CRASH_REPORTS, false);` → `const on = active && consented();` | minidumps (page data) are sent without their own yes | F:telemetry | e2e/telemetry.e2e.ts |
| O17 | telemetry: only our chrome's errors | 65 | `if (!m.sourceName.startsWith(OURS) \|\| m.sourceName.endsWith("-actor.sys.mjs")) return;` → `(removed)` | web pages' own console errors (with their addresses) are reported | F:telemetry | e2e/telemetry.e2e.ts |

## apps/firefox/core/update.ts

| id | guard | line | find → to | lets through | targeted tests | e2e |
|---|---|---|---|---|---|---|
| P1 | update: must be newer | 36 | `compare(version, running) <= 0;` → `compare(version, running) < 0;` | an update of the same version is installed again (replay) | F:update, F:update-xml, F:publish, F:updater-config, F:scripts |  |
| P2 | update: stale update refused | 36 | `(phase === "downloading" \|\| phase === "ready") && !!version && compare(version, running) <= 0;` → `false;` | an older update is installed (downgrade) | F:update, F:update-xml, F:publish, F:updater-config, F:scripts |  |
| P3 | update: ready phase judged | 36 | `(phase === "downloading" \|\| phase === "ready")` → `(phase === "downloading")` | a ready (staged) older update is not dropped | F:update, F:update-xml, F:publish, F:updater-config, F:scripts |  |

## apps/firefox/chrome/store/updates.ts

| id | guard | line | find → to | lets through | targeted tests | e2e |
|---|---|---|---|---|---|---|
| P4 | update: staged app's own version judged | 80 | `if (stale(phase, version) \|\| stale(phase, staged)) {` → `if (stale(phase, version)) {` | an old signed MAR offered under a new number rolls Ressac back | F:update, F:update-xml, F:publish, F:updater-config, F:scripts | e2e/update.e2e.ts |

## apps/firefox/core/update.ts

| id | guard | line | find → to | lets through | targeted tests | e2e |
|---|---|---|---|---|---|---|
| P5 | update: staged version read | 40 | `.exec(plist)?.[1]?.trim() ?? null;` → `.exec("")?.[1]?.trim() ?? null;` | the staged app's version is never read (same downgrade) | F:update, F:update-xml, F:publish, F:updater-config, F:scripts |  |

## apps/firefox/scripts/publish.sh

| id | guard | line | find → to | lets through | targeted tests | e2e |
|---|---|---|---|---|---|---|
| P6 | publish: MAR signed by our key | 41 | `\|\| fail "the MAR is not signed by our key"` → `\|\| true` | publishing accepts a MAR that does not verify | F:update, F:update-xml, F:publish, F:updater-config, F:scripts |  |
| P7 | publish: never backwards | 64 | `[[ $newest == $version ]] \|\| fail "$current is live, newer than $version: bump the version"` → `true` | publishing an older version over a newer live one | F:update, F:update-xml, F:publish, F:updater-config, F:scripts |  |

## apps/firefox/scripts/package.sh

| id | guard | line | find → to | lets through | targeted tests | e2e |
|---|---|---|---|---|---|---|
| P8 | package: MAR signature verifies | 246 | `\|\| { rm -f $mar; fail "the update archive's signature does not verify" }` → `\|\| true` | packaging keeps a MAR whose signature does not verify | F:update, F:update-xml, F:publish, F:updater-config, F:scripts |  |

## apps/firefox/scripts/publish.sh

| id | guard | line | find → to | lets through | targeted tests | e2e |
|---|---|---|---|---|---|---|
| P9 | publish: DMG notarized and accepted | 34 | `xcrun stapler validate $dmg \|\| fail` → `true \|\| fail` | publishing a DMG that is not notarized | F:update, F:update-xml, F:publish, F:updater-config, F:scripts |  |
| P10 | publish: a published version is never rewritten | 49 | `cmp -s $remote $mar \|\| fail` → `true \|\| fail` | a published version's MAR is replaced by another | F:update, F:update-xml, F:publish, F:updater-config, F:scripts |  |

## apps/firefox/chrome/agent/page-guard.ts

| id | guard | line | find → to | lets through | targeted tests | e2e |
|---|---|---|---|---|---|---|
| Q1 | page-guard: decision | 33 | `if (!agentPage(o.from, ports)) return "allow";` → `if (o) return "allow";` | an agent page reaches anything | F:page-guard, F:extensions/network |  |
| Q2 | page-guard: target must be loopback | 36 | `if (loopback(to.hostname) && agentPage(o.to, ports)) return "allow";` → `if (agentPage(o.to, ports)) return "allow";` | an agent page reaches evil.com:5300 | F:page-guard, F:extensions/network |  |
| Q3 | page-guard: target must be on the agent's ports | 36 | `if (loopback(to.hostname) && agentPage(o.to, ports)) return "allow";` → `if (loopback(to.hostname)) return "allow";` | an agent page reaches other local services (Ollama 11434, the MCP port) | F:page-guard, F:extensions/network |  |
| Q4 | page-guard: navigation needs a gesture | 37 | `if (o.document && o.gesture) return "allow";` → `if (o.document) return "allow";` | an agent page navigates the tab anywhere by script (data in the address) | F:page-guard, F:extensions/network |  |
| Q5 | page-guard: gesture only frees a top-level navigation | 37 | `if (o.document && o.gesture) return "allow";` → `if (o.gesture) return "allow";` | after any click, fetch / beacon to anywhere pass | F:page-guard, F:extensions/network |  |
| Q6 | page-guard: CDN GET only | 38 | `return CDN_HOSTS.has(to.hostname) && o.method === "GET" ? "allow" : "cancel";` → `return CDN_HOSTS.has(to.hostname) ? "allow" : "cancel";` | POST to a CDN host passes | F:page-guard, F:extensions/network |  |
| Q7 | page-guard: CDN hosts only | 38 | `return CDN_HOSTS.has(to.hostname) && o.method === "GET" ? "allow" : "cancel";` → `return o.method === "GET" ? "allow" : "cancel";` | GET to any host passes | F:page-guard, F:extensions/network |  |
| Q8 | page-guard: agent page whatever its host (fails closed) | 22 | `return port >= min && port <= max;` → `return port >= min && port <= max && loopback(u.hostname);` | an agent page loaded by a public name resolving to 127.0.0.1 is not guarded | F:page-guard, F:extensions/network |  |
| Q9 | page-guard: loopback is the machine only | 26 | `(host === "localhost" \|\| host === "[::1]" \|\| /^127\.\d+\.\d+\.\d+$/.test(host))` → `(host !== "")` | a LAN address on an agent port (192.168.1.1:5300) is reachable | F:page-guard, F:extensions/network |  |
| Q10 | page-guard: unparsable target cancelled | 35 | `if (!to) return "cancel";` → `if (!to) return "allow";` | an unparsable target passes | F:page-guard, F:extensions/network |  |
| Q11 | page-guard: every principal judged | 65 | `return !froms.every((from) =>` → `return !froms.some((from) =>` | a request passes as soon as one of its principals is not an agent page (worker, about:blank window) | F:page-guard, F:extensions/network | e2e/agent-page-guard.e2e.ts |
| Q12 | page-guard: sandboxed document judged by its creator | 48 | `(p?.isNullPrincipal ? p.precursorPrincipal : p)?.spec ?? ""` → `p?.spec ?? ""` | a sandboxed iframe of an agent page is not guarded | F:page-guard, F:extensions/network | e2e/agent-page-guard.e2e.ts |
| Q13 | page-guard: the request is cancelled | 106 | `ch.cancel(Cr.NS_ERROR_ABORT);` → `(removed)` | blocked requests are only logged (dead proxy remains for those with a proxy step) | F:page-guard, F:extensions/network | e2e/agent-page-guard.e2e.ts |
| Q14 | page-guard: dead proxy for a blocked channel (WebSocket DNS) | 92 | `if (blocked(ch.QueryInterface(Ci.nsIHttpChannel), range)) out = dead;` → `(removed)` | a blocked WebSocket resolves its host name first (DNS leak) | F:page-guard, F:extensions/network | e2e/agent-page-guard.e2e.ts |
| Q15 | page-guard: CDN list | 7 | `"unpkg.com"]` → `"unpkg.com", "example.com"]` | (reverse) one more host in the CDN list: checks the list is pinned | F:page-guard, F:extensions/network |  |

## apps/firefox/chrome/agent/local-guard.ts

| id | guard | line | find → to | lets through | targeted tests | e2e |
|---|---|---|---|---|---|---|
| R1 | local-guard: resolution checked | 33 | `return addresses.length === 0 \|\| addresses.some(localLiteral);` → `return false;` | a public name resolving to 127.0.0.1 is read | F:local-guard, F:test-env, F:invisible-read, F:invisible-paced |  |
| R2 | local-guard: fails closed | 33 | `return addresses.length === 0 \|\| addresses.some(localLiteral);` → `return addresses.some(localLiteral);` | a failed resolution lets the request through | F:local-guard, F:test-env, F:invisible-read, F:invisible-paced |  |
| R3 | local-guard: any local address refuses | 33 | `addresses.some(localLiteral)` → `addresses.every(localLiteral)` | a name with one public and one local address passes | F:local-guard, F:test-env, F:invisible-read, F:invisible-paced |  |
| R4 | local-guard: local literal | 29 | `if (localLiteral(host)) return true;` → `(removed)` | a local IP literal passes (an address is its own resolution) | F:local-guard, F:test-env, F:invisible-read, F:invisible-paced |  |
| R5 | local-guard: test addresses only under automation | 15 | `(automated() ? testEnv(TEST_PUBLIC) : "")` → `testEnv(TEST_PUBLIC)` | RESSAC_TEST_PUBLIC_ADDRESSES is honoured in a normal launch | F:local-guard, F:test-env, F:invisible-read, F:invisible-paced |  |
| R6 | local-guard: observer honours allowLocal only when set | 97 | `if (w?.allowLocal) return;` → `if (w !== null) return;` | a running read's requests to local addresses pass | F:local-guard, F:test-env, F:invisible-read, F:invisible-paced | e2e/invisible.e2e.ts |
| R7 | local-guard: local request cancelled | 101 | `(local) => local && ch.cancel(Cr.NS_ERROR_CONNECTION_REFUSED),` → `(local) => local && undefined,` | a local request is not cancelled | F:local-guard, F:test-env, F:invisible-read, F:invisible-paced | e2e/invisible.e2e.ts |
| R8 | local-guard: reading container guarded for good | 91 | `if (w === undefined && !containers.has(li.originAttributes.userContextId)) return;` → `if (w === undefined) return;` | a service worker outliving its read is not guarded | F:local-guard, F:test-env, F:invisible-read, F:invisible-paced | e2e/invisible.e2e.ts |
| R9 | local-guard: finished read still guarded | 124 | `return () => browsers.set(id, null);` → `return () => void browsers.delete(id);` | a pagehide beacon after the read closed is not guarded | F:local-guard, F:test-env, F:invisible-read, F:invisible-paced | e2e/invisible.e2e.ts |
| R10 | local-guard: top-level allowTop | 93 | `&& !w.allowTop(url)) {` → `&& !w.allowTop(url) && !url) {` | a read's top-level document goes to an address the read refuses | F:local-guard, F:test-env, F:invisible-read, F:invisible-paced | e2e/invisible.e2e.ts |

## apps/firefox/core/sites/navigation.ts

| id | guard | line | find → to | lets through | targeted tests | e2e |
|---|---|---|---|---|---|---|
| S1 | site apps: navigation decision | 32 | `return host !== null && (hostInSite(host, c.domains) \|\| hostInSite(host, c.login)) ? "follow" : "block";` → `return host !== null ? "follow" : "block";` | a site app's view follows a navigation to any https site | F:sites/navigation, F:site-guard, K:sites/urls |  |
| S2 | site apps: open decision | 43 | `return hostInSite(host, c.login) ? "small-window" : "block";` → `return "small-window";` | window.open to any site opens a small window in the app's container | F:sites/navigation, F:site-guard, K:sites/urls |  |
| S3 | site apps: no credentials in addresses | 22 | `if (u.username \|\| u.password) return null;` → `(removed)` | https://user:pw@app-domain/ is followed | F:sites/navigation, F:site-guard, K:sites/urls |  |
| S4 | site apps: https only | 26 | `return u.protocol === "http:" && local ? u.hostname : null;` → `return u.protocol === "http:" ? u.hostname : null;` | plain http to the app's domains is followed | F:sites/navigation, F:site-guard, K:sites/urls |  |
| S5 | site apps: never local | 24 | `if (local && !localUrls) return null;` → `(removed)` | a local https address listed in the domains is followed | F:sites/navigation, F:site-guard, K:sites/urls |  |

## packages/kernel/src/sites/urls.ts

| id | guard | line | find → to | lets through | targeted tests | e2e |
|---|---|---|---|---|---|---|
| S6 | site apps: subdomain needs the dot | 30 | `h.endsWith(`.${n}`)` → `h.endsWith(n)` | evilexample.com counts as on example.com's app | F:sites/navigation, F:site-guard, K:sites/urls |  |

## apps/firefox/chrome/store/sites.ts

| id | guard | line | find → to | lets through | targeted tests | e2e |
|---|---|---|---|---|---|---|
| S7 | site apps: observer follows only allowed pages | 312 | `if (decisionNavigation(url, ctx) === "follow") return;` → `if (url) return;` | the app view loads any page (the observer never cancels) | F:sites/navigation, F:site-guard, K:sites/urls | e2e/sites-navigation.e2e.ts |
| S8 | site apps: a closed app's container loads nothing | 291 | `if (isSiteContainer(userContextId)) ch.cancel(Cr.NS_BINDING_ABORTED);` → `(removed)` | a window that outlived its app keeps loading pages with the app's cookies | F:sites/navigation, F:site-guard, K:sites/urls | e2e/sites-window.e2e.ts |
| S9 | site apps: a sign-in window opens nothing | 322 | `if (s.small.has(bc?.opener?.top?.browserId)) { ⏎ ch.cancel(Cr.NS_BINDING_ABORTED);` → `if (s.small.has(bc?.opener?.top?.browserId)) {` | a sign-in window opens further windows in the app's container | F:sites/navigation, F:site-guard, K:sites/urls | e2e/sites-navigation.e2e.ts |
| S10 | site apps: view shows only the web | 410 | `return Ci.nsIContentPolicy.REJECT_REQUEST;` → `return Ci.nsIContentPolicy.ACCEPT;` | file:, data:, blob:, mailto: load at the top of an app view | F:sites/navigation, F:site-guard, K:sites/urls | e2e/sites-navigation.e2e.ts |
| S11 | site apps: view under the home / card loads only what Ressac starts | 310 | `return void ch.cancel(Cr.NS_BINDING_ABORTED);` → `return;` | the view loads a page before « Entrer » / the grant | F:sites/navigation, F:site-guard, K:sites/urls | e2e/sites-grant.e2e.ts |
| S12 | site apps: a new window's first page decides | 327 | `if (d === "small-window") return void s.small.add(browserId); ⏎ ch.cancel(Cr.NS_BINDING_ABORTED);` → `if (d === "small-window") return void s.small.add(browserId);` | a window.open to a blocked site loads in the app's container | F:sites/navigation, F:site-guard, K:sites/urls | e2e/sites-navigation.e2e.ts |

## apps/firefox/chrome/store/site-frames.ts

| id | guard | line | find → to | lets through | targeted tests | e2e |
|---|---|---|---|---|---|---|
| T1 | site-frames: memory needs the grant | 65 | `const denial: MemoryResponse = { ok: false, error: MEMORY_DENIAL }; ⏎ if (!s \|\| s.site.grantRequired) return denial;` → `const denial: MemoryResponse = { ok: false, error: MEMORY_DENIAL }; ⏎ if (!s) return denial;` | a memory write passes without the user's grant | F:site-frames, F:site-memory |  |
| T2 | site-frames: memory from the main document only | 68 | `const url = f?.main ? relativeUrl(f.url, s.site.domains) : null;` → `const url = f ? relativeUrl(f.url, s.site.domains) : null;` | a sub-frame on the app's domains writes the memory | F:site-frames, F:site-memory |  |
| T3 | site-frames: memory on the app's domains only | 68 | `const url = f?.main ? relativeUrl(f.url, s.site.domains) : null;` → `const url = f?.main ? f.url : null;` | a sign-in page (off the app's domains) writes the memory | F:site-frames, F:site-memory |  |
| T4 | site-frames: injection needs the grant | 49 | `if (!s \|\| s.site.grantRequired) return null; ⏎ const f = frameOf(wgp, s.view); ⏎ if (!f) return null; ⏎ const i = injectionFor` → `if (!s) return null; ⏎ const f = frameOf(wgp, s.view); ⏎ if (!f) return null; ⏎ const i = injectionFor` | tweaks are injected before the grant | F:site-frames, F:site-memory |  |
| T5 | site-frames: frame belongs to an open app's view | 31 | `for (const s of sites) if (s.view === top) return s;` → `for (const s of sites) return s;` | any frame (a tab, a sign-in window) is treated as the first open app's | F:site-frames, F:site-memory |  |
| T6 | site-frames: console source named as the app's tweak | 83 | ` \|\| !source.startsWith(tweakSource(s.site.id, ""))` → `(removed)` | any page error lands in the tweaks' console the agent reads | F:site-frames, F:site-memory |  |
| T7 | site-frames: app container only for the app's pages | 139 | `if (s.site.id === id && relativeUrl(url, s.site.domains) !== null) return profile;` → `if (s.site.id === id) return profile;` | a link leaving the app opens with the app's cookies | F:site-frames, F:site-memory |  |
| T8 | site-frames: opener loop bound | 123 | `bc && !seen.has(bc); bc = bc.opener?.top` → `bc; bc = bc.opener?.top` | an opener cycle hangs the browser (the 0.1.15 freeze) | F:site-frames, F:site-memory |  |
| T9 | site-frames: resume needs the grant | 94 | `if (!s \|\| s.site.grantRequired) return null; ⏎ const f = frameOf(wgp, s.view); ⏎ if (!f \|\| !resumeInFrame` → `if (!s) return null; ⏎ const f = frameOf(wgp, s.view); ⏎ if (!f \|\| !resumeInFrame` | video positions are recorded before the grant | F:site-frames, F:site-memory |  |

## apps/firefox/chrome/store/ui-network.ts

| id | guard | line | find → to | lets through | targeted tests | e2e |
|---|---|---|---|---|---|---|
| U1 | ui-network: WebSocket schemes | 11 | `const BLOCKED = /^(https?\|wss?):/i;` → `const BLOCKED = /^(https?):/i;` | the UI opens a WebSocket to the web | F:ui-network, F:frame-actor, F:remote-frame |  |
| U2 | ui-network: view-source prefix | 16 | `while (/^view-source:/i.test(s)) s = s.slice("view-source:".length);` → `(removed)` | view-source:https://… loads in the UI | F:ui-network, F:frame-actor, F:remote-frame |  |
| U3 | ui-network: scheme case | 11 | `const BLOCKED = /^(https?\|wss?):/i;` → `const BLOCKED = /^(https?\|wss?):/;` | HTTPS://… passes (if a spec is ever not normalised) | F:ui-network, F:frame-actor, F:remote-frame |  |
| U4 | ui-network: deep chain fails closed | 32 | `return d != null;` → `return false;` | a document past 32 ancestors is not the UI's | F:ui-network, F:frame-actor, F:remote-frame |  |
| U5 | ui-network: policy rejects | 90 | `return Ci.nsIContentPolicy.REJECT_REQUEST;` → `return Ci.nsIContentPolicy.ACCEPT;` | the content policy accepts the UI's web loads (the observer remains) | F:ui-network, F:frame-actor, F:remote-frame |  |
| U6 | ui-network: observer cancels | 102 | `channel.cancel(Cr.NS_BINDING_ABORTED);` → `(removed)` | system documents' web loads are not cancelled (their only layer) | F:ui-network, F:frame-actor, F:remote-frame | e2e/ui-network.e2e.ts |
| U7 | ui-network: agent-written remote frames | 72 | `if (bc.isContent) return isFrameBrowser(bc.top?.embedderElement) \|\| (!!li.loadingPrincipal && hasUiAddress(li.loadingPrincipal));` → `if (bc.isContent) return false;` | widget displays, site homes and action components load from the web | F:ui-network, F:frame-actor, F:remote-frame |  |
| U8 | ui-network: loads without a context | 67 | `return !!p && (hasUiAddress(p) \|\|` → `return !!p && !p && (hasUiAddress(p) \|\|` | a UI worker's fetch / WebTransport passes | F:ui-network, F:frame-actor, F:remote-frame |  |
| U9 | ui-network: UI WebRTC denied | 111 | `Services.obs.notifyObservers(null, "PeerConnection:response:deny", subject.callID);` → `(removed)` | a UI document opens a WebRTC connection | F:ui-network, F:frame-actor, F:remote-frame | e2e/ui-network.e2e.ts |
| U10 | ui-network: frames' WebRTC denied | 136 | `console.warn("[ui-network] refused webrtc from a frame"); ⏎ return "deny";` → `return "allow";` | an agent-written frame opens a WebRTC connection | F:ui-network, F:frame-actor, F:remote-frame |  |
| U11 | ui-network: frames origin with its slash | 10 | ``${framesOrigin()}/`]` → `framesOrigin()]` | (over-block) another host sharing the prefix counts as UI | F:ui-network, F:frame-actor, F:remote-frame |  |
| U12 | ui-network: cut frames | 74 | `return !!e && (isUiFrame(e) \|\| isUiDocument(e.ownerDocument));` → `return !!e && isUiDocument(e.ownerDocument);` | a cut frame's own navigation is not judged by its mark | F:ui-network, F:frame-actor, F:remote-frame |  |
| U13 | ui-network: UI document walk | 28 | `if (UI_PREFIXES.some((p) => uri.startsWith(p))) return true;` → `(removed)` | no document is recognised as the UI's by its address | F:ui-network, F:frame-actor, F:remote-frame |  |
| U14 | ui-network: opening observer judges | 98 | `if (!isUiLoad(channel.loadInfo) \|\| !isBlockedAddress(channel.URI.spec)) return;` → `if (channel) return;` | the opening observer does nothing | F:ui-network, F:frame-actor, F:remote-frame | e2e/ui-network.e2e.ts |
| U15 | ui-network: install steps | 164 | `observer: step("observer", () => Services.obs.addObserver(openingObserver, "http-on-opening-request")),` → `observer: step("observer", () => {}),` | the observer is reported installed but never registered | F:ui-network, F:frame-actor, F:remote-frame | e2e/ui-network-fail.e2e.ts |

## apps/firefox/host/relay.ts

| id | guard | line | find → to | lets through | targeted tests | e2e |
|---|---|---|---|---|---|---|
| V1 | relay: session token | 27 | `return x.length === y.length && timingSafeEqual(x, y);` → `return true;` | any bearer gets the real API key used for it | F:relay |  |
| V2 | relay: inference paths only | 47 | `else if (!RELAY_PATHS[session.kind].includes(pathname)) status = 404, reply(res, 404, "Introuvable");` → `(removed)` | any API path is relayed with the key (files, batches, admin; Ollama /api/pull) | F:relay |  |
| V3 | relay: POST only | 48 | `else if (req.method !== "POST") status = 405, reply(res, 405, "Méthode non permise");` → `(removed)` | GET / DELETE relayed with the key | F:relay |  |
| V4 | relay: token constant time | 27 | `return x.length === y.length && timingSafeEqual(x, y);` → `return x.equals(y);` | comparison no longer constant-time (same answers) | F:relay |  |
| V5 | relay: client credentials dropped | 14 | `const DROPPED = new Set(["authorization", "x-api-key", "host", "connection", "content-length", "cookie", "proxy-authorization",` → `const DROPPED = new Set(["authorization", "host", "connection", "content-length", "proxy-authorization",` | the container's own x-api-key / cookie headers go upstream | F:relay |  |

## apps/firefox/chrome/agent/bridge.ts

| id | guard | line | find → to | lets through | targeted tests | e2e |
|---|---|---|---|---|---|---|
| W1 | bridge: private tabs never read | 63 | `if (privateTab(state, o)) throw new PrivateTab(id);` → `(removed)` | a tab of a private space is read | F:agent/bridge |  |
| W2 | bridge: origin re-checked after the read | 85 | `if (originOf(tab(id).url) !== origin \|\| originOf(browser.currentURI.spec) !== origin) ⏎ throw new SiteChanged(id);` → `(removed)` | a tab that changed site during the read gives its new page | F:agent/bridge |  |
| W3 | bridge: read only the origin the kernel checked | 81 | `if (expect !== undefined && originOf(String(expect)) !== origin) throw new SiteChanged(id);` → `(removed)` | a tab already on another origin than the one granted is read | F:agent/bridge |  |
| W4 | bridge: private mirror | 26 | `const isPrivate = (o: Tab \| undefined) => !!o && !internal(o) && privateTab(state, o);` → `const isPrivate = (o: Tab \| undefined) => !!o && !o;` | the kernel is never told which tabs are private (current_page, activity) | F:agent/bridge |  |

## packages/kernel/src/container/workshop.ts

| id | guard | line | find → to | lets through | targeted tests | e2e |
|---|---|---|---|---|---|---|
| X1 | workshop: session only if a direct connection is refused | 465 | `if (probe.code !== 7) fail(` → `if (probe.code < 0) fail(` | a session starts although the web is directly reachable | K:container/workshop |  |
| X2 | workshop: rules must apply | 462 | `if (apply.code !== 0) fail(` → `if (apply.code < 0) fail(` | (the probe remains) a failed rules install is ignored | K:container/workshop |  |
| X3 | workshop: no-new-privileges | 85 | `"--security-opt", "no-new-privileges", ⏎ "--pids-limit", "1024",` → `"--pids-limit", "1024",` | setuid binaries can raise privileges in the container | K:container/workshop |  |
| X4 | workshop: cap-drop ALL | 83 | `"--cap-drop", "ALL", ⏎ // No setuid route` → `// No setuid route` | the container keeps default capabilities (NET_ADMIN under Podman: flush the rules) | K:container/workshop |  |
| X5 | workshop: IPv6 off | 87 | `"--sysctl", "net.ipv6.conf.all.disable_ipv6=1",` → `(removed)` | IPv6 is on (the iptables rules are IPv4 only) | K:container/workshop |  |
| X6 | workshop: .ressac read-only | 514 | `/.ressac:ro` → `/.ressac` | the agent rewrites its launch profiles, MCP config, accepted instructions | K:container/workshop |  |
| X7 | workshop: ports on 127.0.0.1 | 517 | `"-p", `127.0.0.1:${ports}:${ports}`` → `"-p", `${ports}:${ports}`` | the agent's ports are published on every interface of the Mac | K:container/workshop |  |
| X8 | workshop: autoupdater off | 91 | `"-e", "DISABLE_AUTOUPDATER=1",` → `(removed)` | Claude Code's autoupdater is on | K:container/workshop |  |
| X9 | workshop: pids limit | 86 | `"--pids-limit", "1024",` → `(removed)` | no process limit (fork bomb) | K:container/workshop |  |
| X10 | workshop: memory limit | 520 | `"--memory", String(this.memory()),` → `(removed)` | no memory limit on the agent's container | K:container/workshop |  |
| X11 | workshop: only valid domains reach the rules | 460 | `domains: domains.filter(validDomain) }` → `domains }` | (the module filters again) kernel-side domain filter gone | K:container/workshop |  |
| X12 | workshop: proxy env | 90 | `"-e", "NODE_USE_ENV_PROXY=1",` → `(removed)` | (not a barrier) Node ignores the proxy: checks flags are pinned | K:container/workshop |  |
