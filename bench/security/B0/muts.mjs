// B0 mutation catalogue. Each entry: id, guard, file, find (exact, must occur once), to, what the mutation lets through, tests.
// e2e: the guard's wiring only runs inside Firefox; unit tests are still run to see whether any catches it.
const r = String.raw;
const K = "packages/kernel/";
const F = "apps/firefox/";
const k = (...t) => t.map((x) => "K:test/" + x);
const f = (...t) => t.map((x) => "F:test/" + x);

const tSeen = k("mcp/seen.test.ts", "recaps/recaps.test.ts", "mcp/server.test.ts");
const tServer = k("mcp/server.test.ts", "mcp/history.test.ts");
const tSess = k("search/sessions.test.ts", "mcp/server.test.ts");
const tRecap = k("recaps/recaps.test.ts", "mcp/server.test.ts");
const tDetect = k("outflow/detect.test.ts", "outflow/outflow.test.ts", "mcp/server.test.ts");
const tPolicy = k("access/policy.test.ts", "mcp/server.test.ts", "mcp/history.test.ts", "mcp/devtools.test.ts", "mcp/extensions.test.ts");
const tSens = k("access/sensitive.test.ts", "mcp/server.test.ts");
const tLinks = [...k("sites/read.test.ts", "home/theme.test.ts", "design/remarks.test.ts", "workflows/edit.test.ts", "profiles/config-mcp.test.ts", "applications/manifest.test.ts", "container/workshop.test.ts"), ...f("sites-host.test.ts", "home-copy-root.test.ts")];
const tConf = [...k("workspace/confined.test.ts", "container/instruction-files.test.ts", "sites/read.test.ts", "home/theme.test.ts", "design/remarks.test.ts", "workflows/edit.test.ts", "profiles/config-mcp.test.ts", "applications/manifest.test.ts", "container/workshop.test.ts"), ...f("sites-host.test.ts", "home-copy-root.test.ts")];
const tNet = k("container/network-module.test.ts", "container/workshop.test.ts");
const tAccess = [...k("workflows/run.test.ts", "workflows/blocks.test.ts", "workflows/interpreter.test.ts", "sites/urls.test.ts", "recaps/recaps.test.ts", "widgets/harvest.test.ts"), ...f("local-guard.test.ts", "page-guard.test.ts", "sites/navigation.test.ts")];
const tExt = k("design/external-server.test.ts", "design/external.test.ts");
const tInstr = [...k("workspace/instructions.test.ts", "kernel.test.ts", "container/instruction-files.test.ts"), ...f("instruction-review.test.ts")];
const tTel = f("telemetry.test.ts");
const tUpd = f("update.test.ts", "update-xml.test.ts", "publish.test.ts", "updater-config.test.ts", "scripts.test.ts");
const tPG = f("page-guard.test.ts", "extensions/network.test.ts");
const tLG = f("local-guard.test.ts", "test-env.test.ts", "invisible-read.test.ts", "invisible-paced.test.ts");
const tNav = [...f("sites/navigation.test.ts", "site-guard.test.ts"), ...k("sites/urls.test.ts")];
const tSF = f("site-frames.test.ts", "site-memory.test.ts");
const tUI = f("ui-network.test.ts", "frame-actor.test.ts", "remote-frame.test.ts");
const tRelay = f("relay.test.ts");
const tBridge = f("agent/bridge.test.ts");
const tWork = k("container/workshop.test.ts");

const SEEN = K + "src/mcp/seen.ts";
const SERVER = K + "src/mcp/server.ts";
const SESS = K + "src/search/sessions.ts";
const RECAPS = K + "src/recaps/recaps.ts";
const DETECT = K + "src/outflow/detect.ts";
const OUT = K + "src/outflow/outflow.ts";
const POLICY = K + "src/access/policy.ts";
const SENS = K + "src/access/sensitive.ts";
const NOLINKS = K + "src/workspace/no-links.ts";
const CONF = K + "src/workspace/confined.ts";
const NET = K + "docker/ressac-network.mjs";
const ACCESS = K + "src/workflows/access.ts";
const RUN = K + "src/workflows/run.ts";
const EXTSRV = K + "src/design/external-server.ts";
const EXT = K + "src/design/external.ts";
const INSTR = K + "src/workspace/instructions.ts";
const KERNEL = K + "src/kernel.ts";
const WORK = K + "src/container/workshop.ts";
const URLS = K + "src/sites/urls.ts";
const TEL = F + "shared/telemetry.ts";
const TELSTORE = F + "chrome/store/telemetry.ts";
const UPD = F + "core/update.ts";
const UPDSTORE = F + "chrome/store/updates.ts";
const PUBLISH = F + "scripts/publish.sh";
const PACKAGE = F + "scripts/package.sh";
const PG = F + "chrome/agent/page-guard.ts";
const LG = F + "chrome/agent/local-guard.ts";
const NAV = F + "core/sites/navigation.ts";
const SITES = F + "chrome/store/sites.ts";
const SF = F + "chrome/store/site-frames.ts";
const UI = F + "chrome/store/ui-network.ts";
const RELAY = F + "host/relay.ts";
const BRIDGE = F + "chrome/agent/bridge.ts";

export const MUTS = [
  // ── A. exact-address memory (mcp/seen.ts)
  { id: "A1", guard: "seen.ts exact-address", file: SEEN, find: r`if (!this.urls.has(url)) return false;`, to: ``, what: "has() says yes to any address", tests: tSeen },
  { id: "A2", guard: "seen.ts fragment rule", file: SEEN, find: r`if (!this.urls.has(url)) return false;`, to: r`if (!this.urls.has(url) && !this.urls.has(withoutHash(url))) return false;`, what: "has() ignores a fragment the agent added (P#<data> free)", tests: tSeen },
  { id: "A3", guard: "seen.ts web-only", file: SEEN, find: r` && /^https?:$/.test(new URL(url).protocol)`, to: ``, what: "any scheme is remembered as read", tests: tSeen },
  { id: "A4", guard: "seen.ts length cap", file: SEEN, find: r`url.length <= URL_MAX && `, to: ``, what: "addresses over 2000 chars are remembered", tests: tSeen },
  { id: "A5", guard: "seen.ts memory bound", file: SEEN, find: r`if (this.urls.size > SEEN_MAX) this.urls.delete(this.urls.values().next().value!);`, to: ``, what: "the set grows without bound (memory, not a leak)", tests: tSeen },

  // ── B. address rule, consent and outflow wiring in the MCP server (mcp/server.ts)
  { id: "B1", guard: "server.ts composed address (outside search)", file: SERVER, find: r`if (isLocal(url) || seen.has(url) || policy.addressGranted(url)) return null;`, to: r`return null;`, what: "any composed address opens without a card", tests: tServer },
  { id: "B2", guard: "server.ts address card denial", file: SERVER, find: r`if (!yes) return DENIAL_TEXT;`, to: ``, what: "a refused address card still opens the address", tests: tServer },
  { id: "B3", guard: "server.ts links of agent-written pages", file: SERVER, find: r`if (linksFollowable(o)) seen.add(`, to: r`seen.add(`, what: "links of a local page / site app (agent-written) count as read", tests: tServer },
  { id: "B4", guard: "server.ts navigate link from a local page", file: SERVER, find: r`const refusal = link === undefined || isLocal(o.url) ? await composedRefusal(`, to: r`const refusal = link === undefined ? await composedRefusal(`, what: "a numbered link of the agent's own local page navigates without a card", tests: tServer },
  { id: "B5", guard: "server.ts site-app navigate, composed address", file: SERVER, find: r`const refusal = await composedRefusal("navigate", url, reason, extra?.signal);
        if (refusal) return text(refusal);`, to: ``, what: "a site app navigates to an agent-composed address on its domains without a card", tests: tServer },
  { id: "B6", guard: "server.ts site-app navigate, domains", file: SERVER, find: r`if (!bridge.siteUrlAllowed?.(o.site, url)) return text(navigationOutsideSite(url), true);`, to: ``, what: "the kernel lets a site app be navigated off its domains (browser guard remains)", tests: tServer },
  { id: "B7", guard: "server.ts search link rule, open_tab", file: SERVER, find: r`const free = sessions.freeAs(cur.tabId, url);`, to: r`const free = url;`, what: "during a search open_tab opens any address without a card", tests: tServer },
  { id: "B8", guard: "server.ts search link rule, navigate", file: SERVER, find: r`const free = sessions.freeAs(id, url);`, to: r`const free = url;`, what: "the search tab navigates to any address without a card", tests: tServer },
  { id: "B9", guard: "server.ts search link rule, read_pages", file: SERVER, find: r`const free = tabId && sessions.freeAs(tabId, u);`, to: r`const free = u;`, what: "read_pages reads any address without a card", tests: tServer },
  { id: "B10", guard: "server.ts search address card denial", file: SERVER, find: r`if (!yes) return text(DENIAL_TEXT);
          sessions.allow(id, url);`, to: r`sessions.allow(id, url);`, what: "a refused address card during a search still navigates", tests: tServer },
  { id: "B11", guard: "server.ts http(s) only", file: SERVER, find: r`return ["http:", "https:"].includes(new URL(url).protocol);`, to: r`return !!new URL(url);`, what: "open_tab / navigate accept any scheme (file:, javascript:, about:)", tests: tServer },
  { id: "B12", guard: "server.ts readable-tab address", file: SERVER, find: r`.some((t) => t.url === url && policy.canRead(t))`, to: r`.some((t) => t.url === url)`, what: "the address of any open tab, even one the agent may not read, is free", tests: tServer },
  { id: "B13", guard: "server.ts outflow query pause", file: SERVER, find: r`const hit = outflow?.check(key, query);`, to: r`const hit = undefined as ReturnType<NonNullable<typeof outflow>["check"]>;`, what: "a search query is never checked for secrets / read data", tests: tServer },
  { id: "B14", guard: "server.ts outflow red line", file: SERVER, find: r`return hit ? { danger: OUTFLOW_DANGER(locale(), hit) } : {};`, to: r`return {};`, what: "an address card never shows its red line", tests: tServer },
  { id: "B15", guard: "server.ts sensitive tab re-ask", file: SERVER, find: r`if (!isSensitive(o.url)) return true;`, to: r`return true;`, what: "a sensitive tab granted earlier is read during a search with no new card", tests: tServer },
  { id: "B16", guard: "server.ts history re-ask in a search", file: SERVER, find: r`const had = policy.historyGranted();`, to: r`const had = false;`, what: "history/bookmarks granted earlier are read during a search with no new card", tests: tServer },
  { id: "B17", guard: "server.ts history card", file: SERVER, find: r`policy.historyGranted()
      ? Promise.resolve(true)`, to: r`true
      ? Promise.resolve(true)`, what: "history and bookmarks are read with no card at all", tests: tServer },
  { id: "B18", guard: "server.ts tab read consent", file: SERVER, find: r`if (!(await readAccess(o))) return text(DENIAL_TEXT);`, to: ``, what: "read_tab / current_page read any tab with no consent", tests: tServer },
  { id: "B19", guard: "server.ts grant bound to the site seen", file: SERVER, find: r`return policy.canRead(await tab(o.id));
  }`, to: r`return true;
  }`, what: "a grant given while the tab changed site is used for the new site", tests: tServer },
  { id: "B20", guard: "server.ts outflow memory of tab reads", file: SERVER, find: r`if (!exempt(o)) remember(r, siteOf(o.url), linksFollowable(o));`, to: ``, what: "what the agent reads in a tab is never remembered (rule 2 blind for tabs)", tests: tServer },
  { id: "B21", guard: "server.ts shared-tab exemption vs sensitive", file: SERVER, find: r`policy.sharedByUser(o.id, o.url) && !isSensitive(o.url);`, to: r`policy.sharedByUser(o.id, o.url);`, what: "a sensitive tab the user spoke from is not remembered either", tests: tServer },
  { id: "B22", guard: "MCP bearer token", file: SERVER, find: r`return received.length === expected.length && timingSafeEqual(received, expected);`, to: r`return true;`, what: "any or no token is accepted", tests: tServer },
  { id: "B23", guard: "MCP bearer token, constant time", file: SERVER, find: r`return received.length === expected.length && timingSafeEqual(received, expected);`, to: r`return received.equals(expected);`, what: "comparison no longer constant-time (same answers, timing leak)", tests: tServer },
  { id: "B24", guard: "MCP server listens on localhost", file: SERVER, find: r`o.host ?? "127.0.0.1"`, to: r`o.host ?? "0.0.0.0"`, what: "the MCP server listens on every interface by default", tests: tServer },
  { id: "B25", guard: "server.ts search-tab sensitive page remembered", file: SERVER, find: r`if (isSensitive(now.url)) remember(shown, siteOf(now.url), true);`, to: ``, what: "a signed-in sensitive page read on the search tab is not remembered", tests: tServer },

  // ── C. search sessions (search/sessions.ts)
  { id: "C1", guard: "sessions.ts free address", file: SESS, find: r`if (free.has(x.href)) return x.href;`, to: r`return x.href;`, what: "every address is free during a search", tests: tSess },
  { id: "C2", guard: "sessions.ts added fragment dropped", file: SESS, find: r`x.hash = "";
    return free.has(x.href) ? x.href : undefined;`, to: r`const full = x.href;
    x.hash = "";
    return free.has(x.href) ? full : undefined;`, what: "a fragment the agent added to a read address is kept (data to the page's script)", tests: tSess },

  // ── D. recap links (recaps/recaps.ts)
  { id: "D1", guard: "recap links only to read addresses", file: RECAPS, find: r`chains.filter((s) => kept.has(s) || p.seen.has(s))`, to: r`chains.filter(() => true)`, what: "a recap may link to any address", tests: tRecap },
  { id: "D2", guard: "recap open, allowed set", file: RECAPS, find: r`openable(url, httpsOnly) && !!(await allowedSet(id))?.has(url)`, to: r`openable(url, httpsOnly)`, what: "opening from a recap accepts any web address", tests: tRecap },
  { id: "D3", guard: "recap open, local addresses", file: RECAPS, find: r`return !u.username && !u.password && !localUrl(u.hostname);`, to: r`return !u.username && !u.password;`, what: "a recap link may point to a local address", tests: tRecap },
  { id: "D4", guard: "recap open, credentials", file: RECAPS, find: r`return !u.username && !u.password && !localUrl(u.hostname);`, to: r`return !localUrl(u.hostname);`, what: "a recap link may carry user:password@", tests: tRecap },

  // ── E. secret detection (outflow/detect.ts)
  { id: "E1", guard: "detect.ts findSecrets", file: DETECT, find: r`export function findSecrets(text: string): Secret[] {`, to: r`export function findSecrets(text: string): Secret[] {
  if (text !== undefined) return [];`, what: "no secret is ever found", tests: tDetect },
  { id: "E2", guard: "detect.ts decodings", file: DETECT, find: r`const all = [...new Set(decodings(text).map(plain))];`, to: r`const all = [plain(text)];`, what: "a secret in base64, hex or URL-encoding is missed", tests: tDetect },
  { id: "E3", guard: "detect.ts Luhn checksum", file: DETECT, find: r`if (shaped && issued(digits) && luhnValid(digits)) {`, to: r`if (shaped && issued(digits)) {`, what: "any issuer-shaped number counts as a card (false pauses; checksum claim)", tests: tDetect },
  { id: "E4", guard: "detect.ts cards", file: DETECT, find: r`for (const value of cards(text)) found.push({ kind: "card", value });`, to: ``, what: "card numbers are not detected", tests: tDetect },
  { id: "E5", guard: "detect.ts IBAN", file: DETECT, find: r`for (const value of ibans(text)) found.push({ kind: "iban", value });`, to: ``, what: "IBANs are not detected", tests: tDetect },
  { id: "E6", guard: "detect.ts NIR", file: DETECT, find: r`if (nirValid(nir)) found.push({ kind: "nir", value: nir });`, to: ``, what: "social security numbers are not detected", tests: tDetect },
  { id: "E7", guard: "detect.ts JWT", file: DETECT, find: r`for (const m of text.matchAll(JWT)) found.push({ kind: "jwt", value: m[0] });`, to: ``, what: "login tokens (JWT) are not detected", tests: tDetect },
  { id: "E8", guard: "detect.ts private key", file: DETECT, find: r`for (const m of text.matchAll(PRIVATE_KEY)) found.push({ kind: "private-key", value: m[0] });`, to: ``, what: "private keys are not detected", tests: tDetect },
  { id: "E9", guard: "detect.ts API keys", file: DETECT, find: r`for (const m of text.matchAll(API_KEY)) found.push({ kind: "api-key", value: m[0] });`, to: ``, what: "access keys are not detected", tests: tDetect },
  { id: "E10", guard: "detect.ts random tokens", file: DETECT, find: r`for (const token of all.flatMap(random))`, to: r`for (const token of [] as string[])`, what: "unknown high-entropy tokens are not detected", tests: tDetect },
  { id: "E11", guard: "detect.ts NFKC folding", file: DETECT, find: r`export const plain = (s: string) => s.normalize("NFKC").replace(`, to: r`export const plain = (s: string) => s.replace(`, what: "full-width digits / compatibility forms hide a number", tests: tDetect },
  { id: "E12", guard: "detect.ts hex decoding", file: DETECT, find: r`(form: string) => form.replace(/[0-9a-fA-F]{16,}/g, (s) => printable(Buffer.from(s, "hex")) ?? s),`, to: ``, what: "a hex-encoded secret is missed", tests: tDetect },
  { id: "E13", guard: "detect.ts base64 decoding", file: DETECT, find: r`(form: string) => form.replace(/[A-Za-z0-9+/]{16,}={0,2}/g, (s) => printable(Buffer.from(s, "base64")) ?? s),
  (form: string) => form.replace(/[A-Za-z0-9_-]{16,}={0,2}/g, (s) => printable(Buffer.from(s, "base64")) ?? s),`, to: ``, what: "a base64-encoded secret is missed", tests: tDetect },
  { id: "E14", guard: "detect.ts URL decoding", file: DETECT, find: r`const next = node.url < 3 ?`, to: r`const next = node.url < 0 ?`, what: "a percent-encoded secret is missed", tests: tDetect },
  { id: "E15", guard: "detect.ts double encoding", file: DETECT, find: r`if (node.rounds < 2)`, to: r`if (node.rounds < 1)`, what: "a secret encoded twice (base64 of base64, hex of base64) is missed", tests: tDetect },
  { id: "E16", guard: "detect.ts mask", file: DETECT, find: r`const n = Math.min(4, Math.floor(value.length / 4));`, to: r`const n = Math.min(4, Math.floor(value.length / 4));
  if (n >= 0) return value;`, what: "the caught secret is shown whole in the pause / red line", tests: tDetect },
  { id: "E17", guard: "detect.ts IBAN checksum", file: DETECT, find: r`if (iban.length === IBAN_LENGTHS.get(iban.slice(0, 2)) && ibanValid(iban)) found.push(iban);`, to: r`if (iban.length === IBAN_LENGTHS.get(iban.slice(0, 2))) found.push(iban);`, what: "any IBAN-shaped string counts (false pauses; checksum claim)", tests: tDetect },
  { id: "E18", guard: "detect.ts NIR checksum", file: DETECT, find: r`if (nirValid(nir)) found.push({ kind: "nir", value: nir });`, to: r`found.push({ kind: "nir", value: nir });`, what: "any NIR-shaped number counts (false pauses; checksum claim)", tests: tDetect },

  // ── F. outflow rules (outflow/outflow.ts)
  { id: "F1", guard: "outflow.ts check", file: OUT, find: r`const w = this.wins.get(win);
    const typedNow`, to: r`const w = this.wins.get(win);
    if (out !== undefined) return undefined;
    const typedNow`, what: "nothing leaving is ever flagged", tests: tDetect },
  { id: "F2", guard: "outflow.ts rule 2 (read data coming back)", file: OUT, find: r`if (!w?.read.size) return undefined;`, to: r`if (w !== null) return undefined;`, what: "read e-mails, phones, numbers, ids are never caught coming back", tests: tDetect },
  { id: "F3", guard: "outflow.ts typed text forgotten per conversation", file: OUT, find: r`w.typedItems.clear();
    w.typedText = w.buffer = w.carry = "";`, to: ``, what: "what the user typed in an earlier conversation stays free to send", tests: tDetect },
  { id: "F4", guard: "outflow.ts followable links only from the user's sources", file: OUT, find: r`const found = Array.isArray(links) ? links : links ? [`, to: r`const found = Array.isArray(links) ? links : text ? [`, what: "an address in a tool output the agent writes becomes a followed link (never flagged)", tests: tDetect },
  { id: "F5", guard: "outflow.ts rule 2 through encodings", file: OUT, find: r`for (const soft of new Set(variants(out).map(softNorm))) {`, to: r`for (const soft of new Set([softNorm(out)])) {`, what: "read data sent back in base64 / hex / URL-encoding is missed", tests: tDetect },
  { id: "F6", guard: "outflow.ts rule 2 across path segments", file: OUT, find: r`if (glued === soft) continue;`, to: r`if (glued !== null) continue;`, what: "read data split across URL path segments is missed", tests: tDetect },
  { id: "F7", guard: "outflow.ts e-mails remembered", file: OUT, find: r`for (const m of text.matchAll(EMAIL)) others.push({ at: m.index, kind: "email", value: m[0] });`, to: ``, what: "read e-mail addresses are not remembered", tests: tDetect },
  { id: "F8", guard: "outflow.ts phones remembered", file: OUT, find: r`for (const m of text.matchAll(PHONE)) others.push({ at: m.index, kind: "phone", value: m[0].replace(/\D/g, "") });`, to: ``, what: "read phone numbers are not remembered as phones", tests: tDetect },
  { id: "F9", guard: "outflow.ts long numbers remembered", file: OUT, find: r`if (run.replace(/\D/g, "").length >= DIGIT_CHUNK && !DATE.test(run))`, to: r`if (run === null)`, what: "read long numbers are not remembered", tests: tDetect },
  { id: "F10", guard: "outflow.ts identifiers remembered", file: OUT, find: r`if (o.length >= TEXT_CHUNK && /[a-z]/i.test(o) && /\d/.test(o)) others.push({ at: m.index, kind: "token", value: m[0] });`, to: ``, what: "read identifiers are not remembered", tests: tDetect },
  { id: "F11", guard: "outflow.ts norm NFKC", file: OUT, find: r`const norm = (s: string) => s.normalize("NFKC").toLowerCase()`, to: r`const norm = (s: string) => s.toLowerCase()`, what: "full-width / compatibility forms dodge the comparison", tests: tDetect },
  { id: "F12", guard: "outflow.ts typed exemption scope", file: OUT, find: r`if (typed(n)) continue;`, to: r`if (w) continue;`, what: "rule 1 exempts every secret once the window has any state", tests: tDetect },
  { id: "F13", guard: "outflow.ts whole-address exemption only for addresses", file: OUT, find: r`if (address && w.urls.has(sameAddress(out) ?? "")) return undefined;`, to: r`if (address) return undefined;`, what: "rule 2 never applies to an address the agent opens", tests: tDetect },

  // ── G. access policy (access/policy.ts)
  { id: "G1", guard: "policy.ts canRead", file: POLICY, find: r`return org !== null && this.permissions.get(o.id) === org;
  }

  /** The user shows the agent the data of this widget`, to: r`return true;
  }

  /** The user shows the agent the data of this widget`, what: "every tab is readable", tests: tPolicy },
  { id: "G2", guard: "policy.ts one origin per permission", file: POLICY, find: r`return org !== null && this.permissions.get(o.id) === org;
  }

  /** The user shows the agent the data of this widget`, to: r`return org !== null && this.permissions.has(o.id);
  }

  /** The user shows the agent the data of this widget`, what: "a permission holds for the tab whatever its origin", tests: tPolicy },
  { id: "G3", guard: "policy.ts site app read by its grant only", file: POLICY, find: r`if (o.site !== undefined) return this.grantedSiteRead(o.site, o.hash);`, to: ``, what: "a site app is readable through a tab permission on the same origin", tests: tPolicy },
  { id: "G4", guard: "policy.ts allow() never for a site app", file: POLICY, find: r`if (o.site !== undefined) return false;`, to: ``, what: "a site app window gets an origin permission", tests: tPolicy },
  { id: "G5", guard: "policy.ts user navigation lapses the permission", file: POLICY, find: r`if (this.permissions.get(id) !== org) this.permissions.delete(id);`, to: ``, what: "the permission survives the user changing site", tests: tPolicy },
  { id: "G6", guard: "policy.ts agent navigation keeps access on the same site only", file: POLICY, find: r`if (org && (org === this.permissions.get(id) || this.qualify(url))) this.permissions.set(id, org);`, to: r`if (org) this.permissions.set(id, org);`, what: "the agent navigates a granted tab to another site and keeps read access", tests: tPolicy },
  { id: "G7", guard: "policy.ts tab opened by the agent", file: POLICY, find: r`if (this.qualify(o.url) || (o.app && isLocal(o.url))) this.allow(o);`, to: r`this.allow(o);`, what: "any tab the agent opens is readable at once (Gmail, bank)", tests: tPolicy },
  { id: "G8", guard: "policy.ts demo port range", file: POLICY, find: r`return port > 0 && this.portBuilt(port);`, to: r`return port > 0;`, what: "any local port counts as the agent's demo (the user's dev server, an admin page)", tests: tPolicy },
  { id: "G9", guard: "policy.ts reset clears permissions", file: POLICY, find: r`this.permissions.clear();
    this.rights.clear();`, to: r`this.rights.clear();`, what: "tab permissions survive a new conversation", tests: tPolicy },
  { id: "G10", guard: "policy.ts reset clears data grants", file: POLICY, find: r`this.widgetsData.clear();`, to: ``, what: "history, address and widget grants survive a new conversation", tests: tPolicy },
  { id: "G11", guard: "policy.ts reset clears site grants", file: POLICY, find: r`this.sitesRead.clear();`, to: ``, what: "site app grants survive a new conversation", tests: tPolicy },
  { id: "G12", guard: "policy.ts site grant bound to the declaration hash", file: POLICY, find: r`return this.sitesRead.has(id) && this.sitesRead.get(id) === (hash ?? null);`, to: r`return this.sitesRead.has(id);`, what: "a site app whose declaration changed after the card stays granted", tests: tPolicy },
  { id: "G13", guard: "policy.ts dev rights lapse on origin change", file: POLICY, find: r`if (this.rights.get(id)?.origin !== org) this.rights.delete(id);`, to: ``, what: "run_js / console rights are kept in memory after the tab changes origin", tests: tPolicy },
  { id: "G14", guard: "policy.ts dev rights valid for one origin", file: POLICY, find: r`(grants?.origin === org && grants.list.has(d))`, to: r`(!!grants && grants.list.has(d))`, what: "run_js granted on one origin is valid on any origin of that tab", tests: tPolicy },
  { id: "G15", guard: "policy.ts no dev rights on an ungranted site app", file: POLICY, find: r`if (o.site !== undefined && !this.grantedSiteRead(o.site, o.hash)) return [];`, to: ``, what: "dev rights on a site app without its grant", tests: tPolicy },
  { id: "G16", guard: "policy.ts cut removes read", file: POLICY, find: r`if (!d) this.permissions.delete(id);`, to: ``, what: "the user's cut leaves read access", tests: tPolicy },
  { id: "G17", guard: "policy.ts opaque origins", file: POLICY, find: r`return o === "null" ? null : o;`, to: r`return o;`, what: "data:, about:blank, file: tabs all share the origin 'null': one grant covers them all", tests: tPolicy },
  { id: "G18", guard: "policy.ts site app never 'built'", file: POLICY, find: r`if (!org || o.site !== undefined || !(o.app || this.qualify(o.url))) return;`, to: r`if (!org || !(o.app || this.qualify(o.url))) return;`, what: "a site app served locally gets the default dev rights of a built page", tests: tPolicy },
  { id: "G19", guard: "policy.ts deleted site app loses its grant", file: POLICY, find: r`this.sitesRead.delete(id);
    this.siteRemovals`, to: r`this.siteRemovals`, what: "an app recreated with the same id is read without a new card", tests: tPolicy },
  { id: "G20", guard: "policy.ts address approved", file: POLICY, find: 'return this.widgetsData.has(`address:${url}`);', to: r`return true;`, what: "every address counts as approved earlier", tests: tPolicy },
  { id: "G21", guard: "policy.ts built mark lapses on origin change", file: POLICY, find: r`if (this.builtTabs.get(id) !== org) this.builtTabs.delete(id);`, to: ``, what: "the 'built' mark stays in memory after the tab leaves its origin", tests: tPolicy },

  // ── H. sensitive sites (access/sensitive.ts)
  { id: "H1", guard: "sensitive.ts host list", file: SENS, find: r`if (HOSTS.some((d) => host === d || host.endsWith("." + d))) return true;`, to: ``, what: "listed mail / bank / payment hosts are not sensitive", tests: tSens },
  { id: "H2", guard: "sensitive.ts subdomains", file: SENS, find: r`host === d || host.endsWith("." + d)`, to: r`host === d`, what: "a subdomain of a listed host (www.paypal.com) is not sensitive", tests: tSens },
  { id: "H3", guard: "sensitive.ts trailing dot", file: SENS, find: r`const host = u.hostname.toLowerCase().replace(/\.+$/, "");`, to: r`const host = u.hostname.toLowerCase();`, what: "'mail.google.com.' is not sensitive", tests: tSens },
  { id: "H4", guard: "sensitive.ts wrappers", file: SENS, find: r`if (u.protocol === "view-source:" || u.protocol === "blob:" || reader !== null) return depth >= 3 || isSensitive(reader ?? u.pathname, depth + 1);`, to: ``, what: "view-source:, blob: and reader view of a sensitive page are not sensitive", tests: tSens },
  { id: "H5", guard: "sensitive.ts nesting fails closed", file: SENS, find: r`return depth >= 3 || isSensitive(`, to: r`return depth < 3 && isSensitive(`, what: "deep wrapper nesting is judged not sensitive", tests: tSens },
  { id: "H6", guard: "sensitive.ts account path segments", file: SENS, find: r`if (parts.some((p) => SEGMENTS.has(p))) return true;`, to: ``, what: "/settings, /account, /login pages are not sensitive", tests: tSens },
  { id: "H7", guard: "sensitive.ts webmail on its own host", file: SENS, find: r`if (/^(?:web)?mail\./.test(host)) return true;`, to: ``, what: "mail.* / webmail.* hosts are not sensitive", tests: tSens },
  { id: "H8", guard: "sensitive.ts about:logins", file: SENS, find: r`return /^(logins|preferences)$/.test(u.pathname.toLowerCase());`, to: r`return false;`, what: "about:logins is not sensitive", tests: tSens },
  { id: "H9", guard: "sensitive.ts Slack workspaces", file: SENS, find: r`if (host.endsWith(".slack.com") && host !== "www.slack.com" && host !== "api.slack.com") return true;`, to: ``, what: "Slack workspaces are not sensitive", tests: tSens },
  { id: "H10", guard: "sensitive.ts path case", file: SENS, find: r`const parts = u.pathname.toLowerCase().split("/").filter(Boolean);`, to: r`const parts = u.pathname.split("/").filter(Boolean);`, what: "/Settings or /LOGIN is not sensitive", tests: tSens },
  { id: "H11", guard: "sensitive.ts unparsable address", file: SENS, find: r`  } catch {
    return false;
  }
  // these wrappers`, to: r`  } catch {
    return true;
  }
  // these wrappers`, what: "(reverse) an unreadable address becomes sensitive: checks the fail-open default is pinned", tests: tSens },

  // ── I. link-free folders (workspace/no-links.ts)
  { id: "I1", guard: "no-links.ts linkFree", file: NOLINKS, find: r`return real === join(r, relative(root, folder));`, to: r`return true;`, what: "a folder reached through a planted symlink is accepted", tests: tLinks },
  { id: "I2", guard: "no-links.ts missing folder", file: NOLINKS, find: r`  } catch {
    return false;`, to: r`  } catch {
    return true;`, what: "a missing or unreadable folder counts as link-free", tests: tLinks },

  // ── J. confined file work (workspace/confined.ts)
  { id: "J1", guard: "confined.ts enter: folder is not a link", file: CONF, find: r`const l = fs.lstatSync(path);
    if (!l.isDirectory()) throw new Error("not a real folder");`, to: r`const l = fs.statSync(path);
    if (!l.isDirectory()) throw new Error("not a real folder");`, what: "enter() follows a symlinked folder", tests: tConf },
  { id: "J2", guard: "confined.ts enter: same inode after chdir", file: CONF, find: r`if (here.dev !== l.dev || here.ino !== l.ino) throw new Error("folder changed");`, to: ``, what: "a folder swapped for a link between lstat and chdir is entered (race)", tests: tConf },
  { id: "J3", guard: "confined.ts enter: names", file: CONF, find: r`if (name === "" || name === "." || name === ".." || name.includes("/")) throw new Error("bad name");`, to: ``, what: "'..' or 'a/b' as a folder name walks out", tests: tConf },
  { id: "J4", guard: "confined.ts readFiles: path parts", file: CONF, find: r`if (parts.some((p) => p === "" || p === "." || p === "..")) return "refused";`, to: ``, what: "'../x' as a file path reads outside the folder", tests: tConf },
  { id: "J5", guard: "confined.ts readFiles: intermediate folder is not a link", file: CONF, find: r`const l = fs.lstatSync(part, { throwIfNoEntry: false });`, to: r`const l = fs.statSync(part, { throwIfNoEntry: false });`, what: "a symlinked sub-folder is followed on the way to a file", tests: tConf },
  { id: "J6", guard: "confined.ts readFiles: file is not a link (lstat)", file: CONF, find: r`const l = fs.lstatSync(name, { throwIfNoEntry: false });
    if (!l) return "absent";
    if (!l.isFile()) return "refused";`, to: r`const l = fs.statSync(name, { throwIfNoEntry: false });
    if (!l) return "absent";
    if (!l.isFile()) return "refused";`, what: "lstat check on the file gone (O_NOFOLLOW still there)", tests: tConf },
  { id: "J7", guard: "confined.ts readFiles: O_NOFOLLOW", file: CONF, find: r`fs.openSync(name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)`, to: r`fs.openSync(name, O_RDONLY | O_NONBLOCK)`, what: "a file swapped for a link after lstat is followed (race)", tests: tConf },
  { id: "J8", guard: "confined.ts readFiles: link file (both checks)", file: CONF, find: r`const l = fs.lstatSync(name, { throwIfNoEntry: false });
    if (!l) return "absent";
    if (!l.isFile()) return "refused";
    if (l.size > max) return "big";
    const fd = fs.openSync(name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);`, to: r`const l = fs.statSync(name, { throwIfNoEntry: false });
    if (!l) return "absent";
    if (!l.isFile()) return "refused";
    if (l.size > max) return "big";
    const fd = fs.openSync(name, O_RDONLY | O_NONBLOCK);`, what: "a symlinked file is read (/etc/passwd, ~/.ssh)", tests: tConf },
  { id: "J9", guard: "confined.ts writeEntries: temp O_EXCL|O_NOFOLLOW", file: CONF, find: r`fs.openSync(temp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o666)`, to: r`fs.openSync(temp, O_WRONLY | O_CREAT, 0o666)`, what: "a pre-planted link at the temp name is written through (needs guessing 4 random bytes)", tests: tConf },
  { id: "J10", guard: "confined.ts moveEntry: parent is not a link", file: CONF, find: r`const p = fs.lstatSync(parent);`, to: r`const p = fs.statSync(parent);`, what: "moveEntry works through a symlinked parent", tests: tConf },
  { id: "J11", guard: "confined.ts moveEntry: entry is a real folder", file: CONF, find: r`if (!fs.lstatSync(name).isDirectory()) return "refused";`, to: ``, what: "moveEntry renames a link or a file", tests: tConf },
  { id: "J12", guard: "confined.ts readFiles: size cap", file: CONF, find: r`if (l.size > max) return "big";`, to: ``, what: "(the read loop still caps at max+1) lstat size check gone", tests: tConf },
  { id: "J13", guard: "confined.ts readFiles: grown file refused", file: CONF, find: r`if (size > max || (total += size) > totalMax) return "big";`, to: r`if ((total += size) > totalMax) return "big";`, what: "a file that grew past max since lstat is cut, not refused", tests: tConf },

  // ── K. the agent's network (docker/ressac-network.mjs)
  { id: "K1", guard: "network: allowlist match", file: NET, find: r`return domains.some((d) => (d.startsWith("*.") ? h.endsWith(d.slice(1)) && h.length > d.length - 1 : h === d));`, to: r`return true;`, what: "the proxy lets every host through", tests: tNet },
  { id: "K2", guard: "network: wildcard needs the dot", file: NET, find: r`h.endsWith(d.slice(1))`, to: r`h.endsWith(d.slice(2))`, what: "'*.example.com' also matches evilexample.com", tests: tNet },
  { id: "K3", guard: "network: exact host match", file: NET, find: r` : h === d));`, to: r` : h.endsWith(d)));`, what: "'github.com' also matches evilgithub.com", tests: tNet },
  { id: "K4", guard: "network: iptables tcp reject", file: NET, find: r`"-A OUTPUT -p tcp -j REJECT --reject-with tcp-reset",`, to: ``, what: "(final REJECT remains) tcp-reset line gone", tests: tNet },
  { id: "K5", guard: "network: iptables final reject", file: NET, find: r`"-A OUTPUT -j REJECT",`, to: ``, what: "ICMP and other protocols leave the container", tests: tNet },
  { id: "K6", guard: "network: iptables udp reject", file: NET, find: r`"-A OUTPUT -p udp -j REJECT --reject-with icmp-port-unreachable",`, to: ``, what: "(final REJECT remains) udp line gone", tests: tNet },
  { id: "K7", guard: "network: Mac reachable on given ports only", file: NET, find: r`/32 -p tcp --dport `, to: r`/32 -m comment --comment `, what: "every port of the Mac is reachable from the container", tests: tNet },
  { id: "K8", guard: "network: all three rejects", file: NET, find: r`"-A OUTPUT -p udp -j REJECT --reject-with icmp-port-unreachable",
    "-A OUTPUT -p tcp -j REJECT --reject-with tcp-reset",
    "-A OUTPUT -j REJECT",`, to: ``, what: "the container's outbound network is fully open", tests: tNet },
  { id: "K9", guard: "network: proxy refuses private addresses", file: NET, find: r`if (list.some((a) => localAddress(a.address, a.family))) return cb(`, to: r`if (list.length < 0) return cb(`, what: "an allowed name resolving to the Mac / LAN / router is connected to", tests: tNet },
  { id: "K10", guard: "network: 192.168/16 private", file: NET, find: r`, ["192.168.0.0", 16]`, to: ``, what: "192.168.x.x is not private for the proxy", tests: tNet },
  { id: "K11", guard: "network: 169.254/16 link-local", file: NET, find: r`["169.254.0.0", 16], `, to: ``, what: "link-local (cloud metadata) is not private for the proxy", tests: tNet },
  { id: "K12", guard: "network: 100.64/10 CGNAT", file: NET, find: r`["100.64.0.0", 10], `, to: ``, what: "100.64.x.x (Tailscale, CGNAT) is not private for the proxy", tests: tNet },
  { id: "K13", guard: "network: IPv4-mapped IPv6", file: NET, find: r`if (v4) return LOCAL.check(v4[1], "ipv4");`, to: ``, what: "::ffff:127.0.0.1 is not private for the proxy", tests: tNet },
  { id: "K14", guard: "network: IPv6 unique-local", file: NET, find: r`["fc00::", 7], `, to: ``, what: "fc00::/7 is not private for the proxy", tests: tNet },
  { id: "K15", guard: "network: CONNECT ports", file: NET, find: r`if (!m || !ports.includes(port) || !allowed(m[1], getDomains())) {`, to: r`if (!m || !allowed(m[1], getDomains())) {`, what: "CONNECT to any port of an allowed host (ssh on github.com:22)", tests: tNet },
  { id: "K16", guard: "network: CONNECT host check", file: NET, find: r`if (!m || !ports.includes(port) || !allowed(m[1], getDomains())) {`, to: r`if (!m || !ports.includes(port)) {`, what: "CONNECT to any host on 443/80", tests: tNet },
  { id: "K17", guard: "network: plain HTTP host check", file: NET, find: r`Number(url.port || 80) !== httpPort || !allowed(url.hostname, getDomains())) {`, to: r`Number(url.port || 80) !== httpPort) {`, what: "plain HTTP to any host", tests: tNet },
  { id: "K18", guard: "network: plain HTTP port check", file: NET, find: r`url.protocol !== "http:" || Number(url.port || 80) !== httpPort || `, to: r`url.protocol !== "http:" || `, what: "(the request still goes to httpPort) port check on the asked URL gone", tests: tNet },
  { id: "K19", guard: "network: domain syntax, IP literal", file: NET, find: r` && !/^[0-9.]+$/.test(name)`, to: ``, what: "an IP address is accepted as an allowed 'domain'", tests: tNet },
  { id: "K20", guard: "network: domain syntax, two labels", file: NET, find: r`labels.length >= 2 && `, to: ``, what: "'*.com' or 'localhost' is accepted as an allowed domain", tests: tNet },
  { id: "K21", guard: "network: guarded lookup is the default", file: NET, find: r`localOk = false } = {}`, to: r`localOk = true } = {}`, what: "the real proxy runs without the private-address check", tests: tNet },
  { id: "K22", guard: "network: 127/8 and 10/8", file: NET, find: r`["10.0.0.0", 8], `, to: ``, what: "10.x.x.x is not private for the proxy", tests: tNet },
  { id: "K23", guard: "network: trailing dot / case of the asked host", file: NET, find: r`const h = String(host).toLowerCase().replace(/\.$/, "");`, to: r`const h = String(host);`, what: "(reverse: stricter) 'GitHub.com.' no longer matches; checks normalisation is pinned", tests: tNet },

  // ── L. the kernel's fetch for widgets, actions, workflows (workflows/access.ts)
  { id: "L1", guard: "access.ts localUrl 127/8", file: ACCESS, find: r`a === 0 || a === 10 || a === 127 || `, to: r`a === 0 || a === 10 || `, what: "127.x.x.x is not local", tests: tAccess },
  { id: "L2", guard: "access.ts localUrl 10/8", file: ACCESS, find: r`a === 0 || a === 10 || a === 127 || `, to: r`a === 0 || a === 127 || `, what: "10.x.x.x is not local", tests: tAccess },
  { id: "L3", guard: "access.ts localUrl 169.254/16", file: ACCESS, find: r`(a === 169 && b === 254) || `, to: ``, what: "169.254.x.x (cloud metadata) is not local", tests: tAccess },
  { id: "L4", guard: "access.ts localUrl 172.16/12", file: ACCESS, find: r`(a === 172 && b >= 16 && b <= 31) ||`, to: ``, what: "172.16-31.x.x is not local", tests: tAccess },
  { id: "L5", guard: "access.ts localUrl 192.168/16", file: ACCESS, find: r`(a === 192 && b === 168) || `, to: ``, what: "192.168.x.x is not local", tests: tAccess },
  { id: "L6", guard: "access.ts localUrl 100.64/10", file: ACCESS, find: r`(a === 100 && b >= 64 && b <= 127) || `, to: ``, what: "100.64.x.x is not local", tests: tAccess },
  { id: "L7", guard: "access.ts localUrl multicast / reserved", file: ACCESS, find: r`(a === 100 && b >= 64 && b <= 127) || a >= 224;`, to: r`(a === 100 && b >= 64 && b <= 127);`, what: "224.0.0.0 and above are not local", tests: tAccess },
  { id: "L8", guard: "access.ts localUrl 0/8", file: ACCESS, find: r`return a === 0 || a === 10`, to: r`return a === 10`, what: "0.0.0.0 is not local", tests: tAccess },
  { id: "L9", guard: "access.ts localUrl IPv4-mapped IPv6", file: ACCESS, find: r` || h.startsWith("::ffff:")`, to: ``, what: "[::ffff:127.0.0.1] is not local", tests: tAccess },
  { id: "L10", guard: "access.ts localUrl NAT64", file: ACCESS, find: r` || h.startsWith("64:ff9b:")`, to: ``, what: "64:ff9b:: (NAT64 of an IPv4) is not local", tests: tAccess },
  { id: "L11", guard: "access.ts localUrl IPv6 unique-local", file: ACCESS, find: r` || /^f[cd]/.test(h)`, to: ``, what: "fc00::/7 is not local", tests: tAccess },
  { id: "L12", guard: "access.ts localUrl IPv6 link-local", file: ACCESS, find: r` || /^fe[89ab]/.test(h)`, to: ``, what: "fe80::/10 is not local", tests: tAccess },
  { id: "L13", guard: "access.ts localUrl ::1", file: ACCESS, find: r`return h === "::" || h === "::1" || `, to: r`return h === "::" || `, what: "[::1] is not local", tests: tAccess },
  { id: "L14", guard: "access.ts localUrl trailing dot", file: ACCESS, find: r`const h = host.replace(/^\[|\]$/g, "").toLowerCase().replace(/(?<!\.)\.+$/, "");`, to: r`const h = host.replace(/^\[|\]$/g, "").toLowerCase();`, what: "'localhost.' is not local", tests: tAccess },
  { id: "L15", guard: "access.ts localUrl local names", file: ACCESS, find: r`/\.(localhost|local|internal|home\.arpa)$/`, to: r`/\.(localhost)$/`, what: "x.local, x.internal, x.home.arpa are not local", tests: tAccess },
  { id: "L16", guard: "access.ts localUrl localhost", file: ACCESS, find: r`if (!h || h === "localhost" || `, to: r`if (!h || `, what: "localhost is not local", tests: tAccess },
  { id: "L17", guard: "access.ts localUrl case", file: ACCESS, find: r`const h = host.replace(/^\[|\]$/g, "").toLowerCase().replace(`, to: r`const h = host.replace(/^\[|\]$/g, "").replace(`, what: "'LOCALHOST' is not local (when the caller did not lowercase)", tests: tAccess },
  { id: "L18", guard: "access.ts checkUrl http(s) only", file: ACCESS, find: r`if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("Seules les URL http(s) sont permises");`, to: ``, what: "file:, ftp:, data: accepted by the URL check", tests: tAccess },
  { id: "L19", guard: "access.ts checkUrl no credentials", file: ACCESS, find: r`if (u.username || u.password) throw new Error("URL avec identifiants refusée");`, to: ``, what: "user:password@ addresses accepted", tests: tAccess },
  { id: "L20", guard: "access.ts checkUrl declared domains", file: ACCESS, find: r`if (domains && !domains.includes(host)) throw`, to: r`if (domains && domains.length < 0) throw`, what: "a widget fetches any domain, declared or not", tests: tAccess },
  { id: "L21", guard: "access.ts checkUrl local refused", file: ACCESS, find: r`if (!localUrls && localUrl(host)) throw`, to: r`if (!localUrls && !host) throw`, what: "a widget fetches local addresses by literal", tests: tAccess },
  { id: "L22", guard: "access.ts lookup refuses a local resolution", file: ACCESS, find: r`if (locale) return callback(new Error(`, to: r`if (locale && !host) return callback(new Error(`, what: "a public name resolving to 127.0.0.1 (rebinding) is fetched", tests: tAccess },
  { id: "L23", guard: "access.ts lookup: any local address refuses", file: ACCESS, find: r`const locale = urls.find((a) => localUrl(a.address));`, to: r`const locale = urls.slice(0, 1).find((a) => localUrl(a.address));`, what: "a name with one public and one local address passes", tests: tAccess },
  { id: "L24", guard: "access.ts fetch uses the guarded lookup", file: ACCESS, find: r`...(localUrls ? {} : { lookup: lookupWithoutLocal })`, to: r`...{}`, what: "the fetch connects without the resolution check", tests: tAccess },
  { id: "L25", guard: "access.ts redirects re-checked", file: ACCESS, find: r`const next = checkUrl(new URL(target, url).href, domains, localUrls);`, to: r`const next = new URL(target, url);`, what: "a redirect leads to an undeclared domain or a local literal", tests: tAccess },
  { id: "L26", guard: "access.ts redirect cap", file: ACCESS, find: r`if (redirections >= MAX_REDIRECTIONS) throw new Error("Trop de redirections");`, to: r`if (redirections >= 50) throw new Error("Trop de redirections");`, what: "50 redirects followed instead of 5", tests: tAccess },
  { id: "L27", guard: "access.ts size cap (stream)", file: ACCESS, find: r`if (size > FETCH_MAX_BYTES) {`, to: r`if (size < 0) {`, what: "a response of any size is buffered (when no content-length)", tests: tAccess },
  { id: "L28", guard: "access.ts size cap (content-length)", file: ACCESS, find: r`if (Number(r.headers["content-length"]) > FETCH_MAX_BYTES) {`, to: r`if (Number(r.headers["content-length"]) < 0) {`, what: "(stream cap remains) content-length early refusal gone", tests: tAccess },
  { id: "L29", guard: "access.ts page final address re-checked", file: ACCESS, find: r`checkUrl(String(page?.url), domains, localUrls);`, to: ``, what: "a page read that ended off the declared domains gives its text", tests: tAccess },
  { id: "L30", guard: "run.ts open reads cap (100)", file: RUN, find: r`if (openReads >= MAX_OPEN_READS) throw new Error(TOO_MANY_READS);`, to: ``, what: "no cap on open web reads per run", tests: k("workflows/run.test.ts", "workflows/interpreter.test.ts", "widgets/harvest.test.ts") },

  // ── M. external design-mode server (design/external-server.ts, external.ts)
  { id: "M1", guard: "external-server: Origin refused", file: EXTSRV, find: r`if (req.headers.origin !== undefined) return res.writeHead(403).end();`, to: ``, what: "a web page (with its Origin) may call the server", tests: tExt },
  { id: "M2", guard: "external-server: Host check", file: EXTSRV, find: 'if (host !== `127.0.0.1:${realPort}` && host !== `localhost:${realPort}`) return res.writeHead(403).end();', to: ``, what: "DNS rebinding: any Host header accepted", tests: tExt },
  { id: "M3", guard: "external-server: per-client token", file: EXT, find: r`if (other.length === hash.length && timingSafeEqual(other, hash)) found = c;`, to: r`found = c;`, what: "any token names a client", tests: tExt },
  { id: "M4", guard: "external-server: token constant time", file: EXT, find: r`if (other.length === hash.length && timingSafeEqual(other, hash)) found = c;`, to: r`if (other.equals(hash)) found = c;`, what: "comparison no longer constant-time (same answers)", tests: tExt },
  { id: "M5", guard: "external-server: listens on localhost", file: EXTSRV, find: r`http.listen(o.port, "127.0.0.1", ok);`, to: r`http.listen(o.port, "0.0.0.0", ok);`, what: "the server listens on every interface", tests: tExt },
  { id: "M6", guard: "external-server: capture file name", file: EXTSRV, find: r`if (e.type === "design" && e.capture && CAPTURE_NAME.test(e.capture)) {`, to: r`if (e.type === "design" && e.capture) {`, what: "a capture name like ../../x.png is read from disk", tests: tExt },
  { id: "M7", guard: "external-server: a token is required", file: EXTSRV, find: r`const client = token ? o.registry.tokenClient(token) : null;`, to: r`const client = (token ? o.registry.tokenClient(token) : null) ?? ({ id: "x", name: "x", hash: "", created: "" } as ExternalClient);`, what: "a request with no or a wrong token is served as a made-up client", tests: tExt },

  // ── N. instruction-file gate (workspace/instructions.ts, kernel.ts)
  { id: "N1", guard: "instructions: changes are reported", file: INSTR, find: r`if (now === before) continue;`, to: r`if (now === before || path) continue;`, what: "no change to AGENTS.md / guides / Codex files is ever reported", tests: tInstr },
  { id: "N2", guard: "instructions: Codex's own config lines", file: INSTR, find: r`=> !!lines && lines.every((l) => l.kind === " " || CODEX_OWN_LINE.test(l.text));`, to: r`=> !!lines;`, what: "any config.toml change (model_instructions_file, mcp_servers, notify) is taken in silently", tests: tInstr },
  { id: "N3", guard: "instructions: own-line pattern excludes model_instructions_file", file: INSTR, find: r`|trust_level|model|model_reasoning_effort)`, to: r`|trust_level|model|model_instructions_file|model_reasoning_effort)`, what: "config.toml naming an instruction file is taken in silently", tests: tInstr },
  { id: "N4", guard: "instructions: config.toml watched", file: INSTR, find: r`"/home/node/.codex/AGENTS.override.md", CODEX_CONFIG],`, to: r`"/home/node/.codex/AGENTS.override.md"],`, what: "Codex's config.toml is not watched", tests: tInstr },
  { id: "N5", guard: "instructions: AGENTS.override.md watched", file: INSTR, find: r`"/workspace/AGENTS.override.md", `, to: ``, what: "the workspace AGENTS.override.md is not watched", tests: tInstr },
  { id: "N6", guard: "instructions: skill folders watched", file: INSTR, find: r`trees: ["/workspace/.agents/skills", "/workspace/.codex", "/home/node/.codex/skills", "/home/node/.agents/skills"],`, to: r`trees: [],`, what: "skill folders and the project .codex are not watched", tests: tInstr },
  { id: "N7", guard: "instructions: system skills accepted once only", file: INSTR, find: r`if (!(CODEX_SYSTEM_SEEN in ref))`, to: r`if (ref)`, what: "anything planted under ~/.codex/skills/.system is accepted silently at every session", tests: tInstr },
  { id: "N8", guard: "instructions: accepted AGENTS.md never a marker", file: INSTR, find: r`accepted === undefined || isMarker(accepted) ? "" : accepted`, to: r`accepted ?? ""`, what: "a marker (link target, too-long…) is written as Claude's AGENTS.md", tests: tInstr },
  { id: "N9", guard: "instructions: guides watched", file: INSTR, find: r`const TEXTS = ["AGENTS.md", "guides/widgets.md", "guides/extensions.md", "guides/actions.md", "guides/site-apps.md"];`, to: r`const TEXTS = ["AGENTS.md"];`, what: "the four guides are not watched", tests: tInstr },
  { id: "N10", guard: "kernel.ts gate: a change stops the start", file: KERNEL, find: r`if (changes.length === 0) break;`, to: r`if (changes.length >= 0) break;`, what: "the session starts whatever changed, no card", tests: tInstr },
  { id: "N11", guard: "kernel.ts gate: no reviewer / 3 rounds refuses", file: KERNEL, find: r`if (!review || round === 3) throw new Error(say(loc(), "kernel-err-instructions-changed"));`, to: r`if (!review || round === 3) break;`, what: "with no card available, or after 3 rounds, the session starts on unaccepted files", tests: tInstr },
  { id: "N12", guard: "kernel.ts gate: Claude reads the accepted copy", file: KERNEL, find: r`if (kind === "claude") await instructions.acceptedAgents();`, to: ``, what: "the accepted AGENTS.md copy is not refreshed before a Claude session", tests: tInstr },
  { id: "N13", guard: "kernel.ts gate: Navigateur for both CLIs", file: KERNEL, find: r`const kind = browser && (program === "claude" || program === "codex") ? program : null;`, to: r`const kind = browser && program === "claude" ? program : null;`, what: "Codex sessions in Navigateur skip the gate", tests: tInstr },
  { id: "N14", guard: "kernel.ts gate: revert on refusal", file: KERNEL, find: r`else await instructions.revert(kind, snapshot);`, to: r`else await instructions.keep(kind, snapshot);`, what: "« Revenir » keeps the agent's change", tests: tInstr },

  // ── O. telemetry scrubbing and consent (shared/telemetry.ts, chrome/store/telemetry.ts)
  { id: "O1", guard: "telemetry: addresses scrubbed", file: TEL, find: r`const t = text.replace(PRIVATE_URL, "<url>");`, to: r`const t = text;`, what: "web addresses leave in error reports", tests: tTel },
  { id: "O2", guard: "telemetry: home path scrubbed", file: TEL, find: r`return h ? t.replace(`, to: r`return h && !h ? t.replace(`, what: "the home path (user name) leaves in error reports", tests: tTel },
  { id: "O3", guard: "telemetry: quoted spans dropped", file: TEL, find: r`.replace(QUOTED, '"…"')`, to: ``, what: "quoted text in an error message leaves", tests: tTel },
  { id: "O4", guard: "telemetry: stack frames scrubbed", file: TEL, find: r`.map((f) => ({ ...f, filename: s(f.filename), function: s(f.function) }))`, to: ``, what: "paths and addresses in stack frames leave unscrubbed", tests: tTel },
  { id: "O5", guard: "telemetry: reports off means nothing sent", file: TEL, find: r`if (!urls || !o.enabled() || seen.size >= max) return;`, to: r`if (!urls || seen.size >= max) return;`, what: "error reports are sent with the switch off", tests: tTel },
  { id: "O6", guard: "telemetry: launch count off means nothing sent", file: TEL, find: r`if (!o.enabled()) return o.ids.clear();`, to: ``, what: "the launch count is sent with the switch off", tests: tTel },
  { id: "O7", guard: "telemetry: file:// scrubbed", file: TEL, find: r`(?:https?|wss?|file):`, to: r`(?:https?|wss?):`, what: "file:// paths leave in error reports", tests: tTel },
  { id: "O8", guard: "telemetry: blob:/data: scrubbed", file: TEL, find: r`|blob:|data:)`, to: r`)`, what: "blob: and data: addresses leave in error reports", tests: tTel },
  { id: "O9", guard: "telemetry: no IP inference", file: TEL, find: r`settings: { infer_ip: "never" }`, to: r`settings: {}`, what: "(explicit 0.0.0.0 remains) infer_ip never gone", tests: tTel },
  { id: "O10", guard: "telemetry: unlocatable IP", file: TEL, find: r`user: { ip_address: "0.0.0.0" },`, to: r`user: {},`, what: "(infer_ip never remains) explicit IP gone from error events", tests: tTel },
  { id: "O11", guard: "telemetry: error type scrubbed", file: TEL, find: r`type: s(e.type), value: s(e.message)`, to: r`type: e.type, value: s(e.message)`, what: "an address or path in the error type leaves", tests: tTel },
  { id: "O12", guard: "telemetry: message capped at 300", file: TEL, find: r`.slice(0, 300)`, to: ``, what: "a long error message leaves whole", tests: tTel },
  { id: "O13", guard: "telemetry: home path boundary", file: TEL, find: r`"(?![\\w.-])"`, to: r`""`, what: "/Users/marieX is rewritten as ~X (over-scrub, not a leak)", tests: tTel },
  { id: "O14", guard: "telemetry: session IP", file: TEL, find: r`attrs: { release: o.release, environment: "beta", ip_address: "0.0.0.0" },`, to: r`attrs: { release: o.release, environment: "beta" },`, what: "the launch count lets Sentry derive a city from the IP", tests: tTel },
  { id: "O15", guard: "telemetry: nothing before the notice", file: TELSTORE, e2e: "e2e/telemetry.e2e.ts", find: r`const consented = () => enabled() && Services.prefs.getBoolPref(NOTICE_SHOWN, false);`, to: r`const consented = () => enabled();`, what: "reports and the launch count leave before the notice has shown", tests: tTel },
  { id: "O16", guard: "telemetry: crash reports need their own switch", file: TELSTORE, e2e: "e2e/telemetry.e2e.ts", find: r`const on = active && consented() && Services.prefs.getBoolPref(CRASH_REPORTS, false);`, to: r`const on = active && consented();`, what: "minidumps (page data) are sent without their own yes", tests: tTel },
  { id: "O17", guard: "telemetry: only our chrome's errors", file: TELSTORE, e2e: "e2e/telemetry.e2e.ts", find: r`if (!m.sourceName.startsWith(OURS) || m.sourceName.endsWith("-actor.sys.mjs")) return;`, to: ``, what: "web pages' own console errors (with their addresses) are reported", tests: tTel },

  // ── P. updates (core/update.ts, chrome/store/updates.ts, scripts)
  { id: "P1", guard: "update: must be newer", file: UPD, find: r`compare(version, running) <= 0;`, to: r`compare(version, running) < 0;`, what: "an update of the same version is installed again (replay)", tests: tUpd },
  { id: "P2", guard: "update: stale update refused", file: UPD, find: r`(phase === "downloading" || phase === "ready") && !!version && compare(version, running) <= 0;`, to: r`false;`, what: "an older update is installed (downgrade)", tests: tUpd },
  { id: "P3", guard: "update: ready phase judged", file: UPD, find: r`(phase === "downloading" || phase === "ready")`, to: r`(phase === "downloading")`, what: "a ready (staged) older update is not dropped", tests: tUpd },
  { id: "P4", guard: "update: staged app's own version judged", file: UPDSTORE, e2e: "e2e/update.e2e.ts", find: r`if (stale(phase, version) || stale(phase, staged)) {`, to: r`if (stale(phase, version)) {`, what: "an old signed MAR offered under a new number rolls Ressac back", tests: tUpd },
  { id: "P5", guard: "update: staged version read", file: UPD, find: r`.exec(plist)?.[1]?.trim() ?? null;`, to: r`.exec("")?.[1]?.trim() ?? null;`, what: "the staged app's version is never read (same downgrade)", tests: tUpd },
  { id: "P6", guard: "publish: MAR signed by our key", file: PUBLISH, find: r`|| fail "the MAR is not signed by our key"`, to: r`|| true`, what: "publishing accepts a MAR that does not verify", tests: tUpd },
  { id: "P7", guard: "publish: never backwards", file: PUBLISH, find: r`[[ $newest == $version ]] || fail "$current is live, newer than $version: bump the version"`, to: r`true`, what: "publishing an older version over a newer live one", tests: tUpd },
  { id: "P8", guard: "package: MAR signature verifies", file: PACKAGE, find: r`|| { rm -f $mar; fail "the update archive's signature does not verify" }`, to: r`|| true`, what: "packaging keeps a MAR whose signature does not verify", tests: tUpd },
  { id: "P9", guard: "publish: DMG notarized and accepted", file: PUBLISH, find: r`xcrun stapler validate $dmg || fail`, to: r`true || fail`, what: "publishing a DMG that is not notarized", tests: tUpd },
  { id: "P10", guard: "publish: a published version is never rewritten", file: PUBLISH, find: r`cmp -s $remote $mar || fail`, to: r`true || fail`, what: "a published version's MAR is replaced by another", tests: tUpd },

  // ── Q. agent pages (chrome/agent/page-guard.ts)
  { id: "Q1", guard: "page-guard: decision", file: PG, find: r`if (!agentPage(o.from, ports)) return "allow";`, to: r`if (o) return "allow";`, what: "an agent page reaches anything", tests: tPG },
  { id: "Q2", guard: "page-guard: target must be loopback", file: PG, find: r`if (loopback(to.hostname) && agentPage(o.to, ports)) return "allow";`, to: r`if (agentPage(o.to, ports)) return "allow";`, what: "an agent page reaches evil.com:5300", tests: tPG },
  { id: "Q3", guard: "page-guard: target must be on the agent's ports", file: PG, find: r`if (loopback(to.hostname) && agentPage(o.to, ports)) return "allow";`, to: r`if (loopback(to.hostname)) return "allow";`, what: "an agent page reaches other local services (Ollama 11434, the MCP port)", tests: tPG },
  { id: "Q4", guard: "page-guard: navigation needs a gesture", file: PG, find: r`if (o.document && o.gesture) return "allow";`, to: r`if (o.document) return "allow";`, what: "an agent page navigates the tab anywhere by script (data in the address)", tests: tPG },
  { id: "Q5", guard: "page-guard: gesture only frees a top-level navigation", file: PG, find: r`if (o.document && o.gesture) return "allow";`, to: r`if (o.gesture) return "allow";`, what: "after any click, fetch / beacon to anywhere pass", tests: tPG },
  { id: "Q6", guard: "page-guard: CDN GET only", file: PG, find: r`return CDN_HOSTS.has(to.hostname) && o.method === "GET" ? "allow" : "cancel";`, to: r`return CDN_HOSTS.has(to.hostname) ? "allow" : "cancel";`, what: "POST to a CDN host passes", tests: tPG },
  { id: "Q7", guard: "page-guard: CDN hosts only", file: PG, find: r`return CDN_HOSTS.has(to.hostname) && o.method === "GET" ? "allow" : "cancel";`, to: r`return o.method === "GET" ? "allow" : "cancel";`, what: "GET to any host passes", tests: tPG },
  { id: "Q8", guard: "page-guard: agent page whatever its host (fails closed)", file: PG, find: r`return port >= min && port <= max;`, to: r`return port >= min && port <= max && loopback(u.hostname);`, what: "an agent page loaded by a public name resolving to 127.0.0.1 is not guarded", tests: tPG },
  { id: "Q9", guard: "page-guard: loopback is the machine only", file: PG, find: r`(host === "localhost" || host === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(host))`, to: r`(host !== "")`, what: "a LAN address on an agent port (192.168.1.1:5300) is reachable", tests: tPG },
  { id: "Q10", guard: "page-guard: unparsable target cancelled", file: PG, find: r`if (!to) return "cancel";`, to: r`if (!to) return "allow";`, what: "an unparsable target passes", tests: tPG },
  { id: "Q11", guard: "page-guard: every principal judged", file: PG, e2e: "e2e/agent-page-guard.e2e.ts", find: r`return !froms.every((from) =>`, to: r`return !froms.some((from) =>`, what: "a request passes as soon as one of its principals is not an agent page (worker, about:blank window)", tests: tPG },
  { id: "Q12", guard: "page-guard: sandboxed document judged by its creator", file: PG, e2e: "e2e/agent-page-guard.e2e.ts", find: r`(p?.isNullPrincipal ? p.precursorPrincipal : p)?.spec ?? ""`, to: r`p?.spec ?? ""`, what: "a sandboxed iframe of an agent page is not guarded", tests: tPG },
  { id: "Q13", guard: "page-guard: the request is cancelled", file: PG, e2e: "e2e/agent-page-guard.e2e.ts", find: r`ch.cancel(Cr.NS_ERROR_ABORT);`, to: ``, what: "blocked requests are only logged (dead proxy remains for those with a proxy step)", tests: tPG },
  { id: "Q14", guard: "page-guard: dead proxy for a blocked channel (WebSocket DNS)", file: PG, e2e: "e2e/agent-page-guard.e2e.ts", find: r`if (blocked(ch.QueryInterface(Ci.nsIHttpChannel), range)) out = dead;`, to: ``, what: "a blocked WebSocket resolves its host name first (DNS leak)", tests: tPG },
  { id: "Q15", guard: "page-guard: CDN list", file: PG, find: r`"unpkg.com"]`, to: r`"unpkg.com", "example.com"]`, what: "(reverse) one more host in the CDN list: checks the list is pinned", tests: tPG },

  // ── R. invisible reads (chrome/agent/local-guard.ts)
  { id: "R1", guard: "local-guard: resolution checked", file: LG, find: r`return addresses.length === 0 || addresses.some(localLiteral);`, to: r`return false;`, what: "a public name resolving to 127.0.0.1 is read", tests: tLG },
  { id: "R2", guard: "local-guard: fails closed", file: LG, find: r`return addresses.length === 0 || addresses.some(localLiteral);`, to: r`return addresses.some(localLiteral);`, what: "a failed resolution lets the request through", tests: tLG },
  { id: "R3", guard: "local-guard: any local address refuses", file: LG, find: r`addresses.some(localLiteral)`, to: r`addresses.every(localLiteral)`, what: "a name with one public and one local address passes", tests: tLG },
  { id: "R4", guard: "local-guard: local literal", file: LG, find: r`if (localLiteral(host)) return true;`, to: ``, what: "a local IP literal passes (an address is its own resolution)", tests: tLG },
  { id: "R5", guard: "local-guard: test addresses only under automation", file: LG, find: r`(automated() ? testEnv(TEST_PUBLIC) : "")`, to: r`testEnv(TEST_PUBLIC)`, what: "RESSAC_TEST_PUBLIC_ADDRESSES is honoured in a normal launch", tests: tLG },
  { id: "R6", guard: "local-guard: observer honours allowLocal only when set", file: LG, e2e: "e2e/invisible.e2e.ts", find: r`if (w?.allowLocal) return;`, to: r`if (w !== null) return;`, what: "a running read's requests to local addresses pass", tests: tLG },
  { id: "R7", guard: "local-guard: local request cancelled", file: LG, e2e: "e2e/invisible.e2e.ts", find: r`(local) => local && ch.cancel(Cr.NS_ERROR_CONNECTION_REFUSED),`, to: r`(local) => local && undefined,`, what: "a local request is not cancelled", tests: tLG },
  { id: "R8", guard: "local-guard: reading container guarded for good", file: LG, e2e: "e2e/invisible.e2e.ts", find: r`if (w === undefined && !containers.has(li.originAttributes.userContextId)) return;`, to: r`if (w === undefined) return;`, what: "a service worker outliving its read is not guarded", tests: tLG },
  { id: "R9", guard: "local-guard: finished read still guarded", file: LG, e2e: "e2e/invisible.e2e.ts", find: r`return () => browsers.set(id, null);`, to: r`return () => void browsers.delete(id);`, what: "a pagehide beacon after the read closed is not guarded", tests: tLG },
  { id: "R10", guard: "local-guard: top-level allowTop", file: LG, e2e: "e2e/invisible.e2e.ts", find: r`&& !w.allowTop(url)) {`, to: r`&& !w.allowTop(url) && !url) {`, what: "a read's top-level document goes to an address the read refuses", tests: tLG },

  // ── S. site apps stay on their domains (core/sites/navigation.ts, sites/urls.ts, chrome/store/sites.ts)
  { id: "S1", guard: "site apps: navigation decision", file: NAV, find: r`return host !== null && (hostInSite(host, c.domains) || hostInSite(host, c.login)) ? "follow" : "block";`, to: r`return host !== null ? "follow" : "block";`, what: "a site app's view follows a navigation to any https site", tests: tNav },
  { id: "S2", guard: "site apps: open decision", file: NAV, find: r`return hostInSite(host, c.login) ? "small-window" : "block";`, to: r`return "small-window";`, what: "window.open to any site opens a small window in the app's container", tests: tNav },
  { id: "S3", guard: "site apps: no credentials in addresses", file: NAV, find: r`if (u.username || u.password) return null;`, to: ``, what: "https://user:pw@app-domain/ is followed", tests: tNav },
  { id: "S4", guard: "site apps: https only", file: NAV, find: r`return u.protocol === "http:" && local ? u.hostname : null;`, to: r`return u.protocol === "http:" ? u.hostname : null;`, what: "plain http to the app's domains is followed", tests: tNav },
  { id: "S5", guard: "site apps: never local", file: NAV, find: r`if (local && !localUrls) return null;`, to: ``, what: "a local https address listed in the domains is followed", tests: tNav },
  { id: "S6", guard: "site apps: subdomain needs the dot", file: URLS, find: 'h.endsWith(`.${n}`)', to: r`h.endsWith(n)`, what: "evilexample.com counts as on example.com's app", tests: tNav },
  { id: "S7", guard: "site apps: observer follows only allowed pages", file: SITES, e2e: "e2e/sites-navigation.e2e.ts", find: r`if (decisionNavigation(url, ctx) === "follow") return;`, to: r`if (url) return;`, what: "the app view loads any page (the observer never cancels)", tests: tNav },
  { id: "S8", guard: "site apps: a closed app's container loads nothing", file: SITES, e2e: "e2e/sites-window.e2e.ts", find: r`if (isSiteContainer(userContextId)) ch.cancel(Cr.NS_BINDING_ABORTED);`, to: ``, what: "a window that outlived its app keeps loading pages with the app's cookies", tests: tNav },
  { id: "S9", guard: "site apps: a sign-in window opens nothing", file: SITES, e2e: "e2e/sites-navigation.e2e.ts", find: r`if (s.small.has(bc?.opener?.top?.browserId)) {
      ch.cancel(Cr.NS_BINDING_ABORTED);`, to: r`if (s.small.has(bc?.opener?.top?.browserId)) {`, what: "a sign-in window opens further windows in the app's container", tests: tNav },
  { id: "S10", guard: "site apps: view shows only the web", file: SITES, e2e: "e2e/sites-navigation.e2e.ts", find: r`return Ci.nsIContentPolicy.REJECT_REQUEST;`, to: r`return Ci.nsIContentPolicy.ACCEPT;`, what: "file:, data:, blob:, mailto: load at the top of an app view", tests: tNav },
  { id: "S11", guard: "site apps: view under the home / card loads only what Ressac starts", file: SITES, e2e: "e2e/sites-grant.e2e.ts", find: r`return void ch.cancel(Cr.NS_BINDING_ABORTED);`, to: r`return;`, what: "the view loads a page before « Entrer » / the grant", tests: tNav },
  { id: "S12", guard: "site apps: a new window's first page decides", file: SITES, e2e: "e2e/sites-navigation.e2e.ts", find: r`if (d === "small-window") return void s.small.add(browserId);
    ch.cancel(Cr.NS_BINDING_ABORTED);`, to: r`if (d === "small-window") return void s.small.add(browserId);`, what: "a window.open to a blocked site loads in the app's container", tests: tNav },

  // ── T. site app frames (chrome/store/site-frames.ts)
  { id: "T1", guard: "site-frames: memory needs the grant", file: SF, find: r`const denial: MemoryResponse = { ok: false, error: MEMORY_DENIAL };
  if (!s || s.site.grantRequired) return denial;`, to: r`const denial: MemoryResponse = { ok: false, error: MEMORY_DENIAL };
  if (!s) return denial;`, what: "a memory write passes without the user's grant", tests: tSF },
  { id: "T2", guard: "site-frames: memory from the main document only", file: SF, find: r`const url = f?.main ? relativeUrl(f.url, s.site.domains) : null;`, to: r`const url = f ? relativeUrl(f.url, s.site.domains) : null;`, what: "a sub-frame on the app's domains writes the memory", tests: tSF },
  { id: "T3", guard: "site-frames: memory on the app's domains only", file: SF, find: r`const url = f?.main ? relativeUrl(f.url, s.site.domains) : null;`, to: r`const url = f?.main ? f.url : null;`, what: "a sign-in page (off the app's domains) writes the memory", tests: tSF },
  { id: "T4", guard: "site-frames: injection needs the grant", file: SF, find: r`if (!s || s.site.grantRequired) return null;
  const f = frameOf(wgp, s.view);
  if (!f) return null;
  const i = injectionFor`, to: r`if (!s) return null;
  const f = frameOf(wgp, s.view);
  if (!f) return null;
  const i = injectionFor`, what: "tweaks are injected before the grant", tests: tSF },
  { id: "T5", guard: "site-frames: frame belongs to an open app's view", file: SF, find: r`for (const s of sites) if (s.view === top) return s;`, to: r`for (const s of sites) return s;`, what: "any frame (a tab, a sign-in window) is treated as the first open app's", tests: tSF },
  { id: "T6", guard: "site-frames: console source named as the app's tweak", file: SF, find: r` || !source.startsWith(tweakSource(s.site.id, ""))`, to: ``, what: "any page error lands in the tweaks' console the agent reads", tests: tSF },
  { id: "T7", guard: "site-frames: app container only for the app's pages", file: SF, find: r`if (s.site.id === id && relativeUrl(url, s.site.domains) !== null) return profile;`, to: r`if (s.site.id === id) return profile;`, what: "a link leaving the app opens with the app's cookies", tests: tSF },
  { id: "T8", guard: "site-frames: opener loop bound", file: SF, find: r`bc && !seen.has(bc); bc = bc.opener?.top`, to: r`bc; bc = bc.opener?.top`, what: "an opener cycle hangs the browser (the 0.1.15 freeze)", tests: tSF, timeout: 60 },
  { id: "T9", guard: "site-frames: resume needs the grant", file: SF, find: r`if (!s || s.site.grantRequired) return null;
  const f = frameOf(wgp, s.view);
  if (!f || !resumeInFrame`, to: r`if (!s) return null;
  const f = frameOf(wgp, s.view);
  if (!f || !resumeInFrame`, what: "video positions are recorded before the grant", tests: tSF },

  // ── U. Ressac's own interface (chrome/store/ui-network.ts)
  { id: "U1", guard: "ui-network: WebSocket schemes", file: UI, find: r`const BLOCKED = /^(https?|wss?):/i;`, to: r`const BLOCKED = /^(https?):/i;`, what: "the UI opens a WebSocket to the web", tests: tUI },
  { id: "U2", guard: "ui-network: view-source prefix", file: UI, find: r`while (/^view-source:/i.test(s)) s = s.slice("view-source:".length);`, to: ``, what: "view-source:https://… loads in the UI", tests: tUI },
  { id: "U3", guard: "ui-network: scheme case", file: UI, find: r`const BLOCKED = /^(https?|wss?):/i;`, to: r`const BLOCKED = /^(https?|wss?):/;`, what: "HTTPS://… passes (if a spec is ever not normalised)", tests: tUI },
  { id: "U4", guard: "ui-network: deep chain fails closed", file: UI, find: r`return d != null;`, to: r`return false;`, what: "a document past 32 ancestors is not the UI's", tests: tUI },
  { id: "U5", guard: "ui-network: policy rejects", file: UI, find: r`return Ci.nsIContentPolicy.REJECT_REQUEST;`, to: r`return Ci.nsIContentPolicy.ACCEPT;`, what: "the content policy accepts the UI's web loads (the observer remains)", tests: tUI },
  { id: "U6", guard: "ui-network: observer cancels", file: UI, e2e: "e2e/ui-network.e2e.ts", find: r`channel.cancel(Cr.NS_BINDING_ABORTED);`, to: ``, what: "system documents' web loads are not cancelled (their only layer)", tests: tUI },
  { id: "U7", guard: "ui-network: agent-written remote frames", file: UI, find: r`if (bc.isContent) return isFrameBrowser(bc.top?.embedderElement) || (!!li.loadingPrincipal && hasUiAddress(li.loadingPrincipal));`, to: r`if (bc.isContent) return false;`, what: "widget displays, site homes and action components load from the web", tests: tUI },
  { id: "U8", guard: "ui-network: loads without a context", file: UI, find: r`return !!p && (hasUiAddress(p) ||`, to: r`return !!p && !p && (hasUiAddress(p) ||`, what: "a UI worker's fetch / WebTransport passes", tests: tUI },
  { id: "U9", guard: "ui-network: UI WebRTC denied", file: UI, e2e: "e2e/ui-network.e2e.ts", find: r`Services.obs.notifyObservers(null, "PeerConnection:response:deny", subject.callID);`, to: ``, what: "a UI document opens a WebRTC connection", tests: tUI },
  { id: "U10", guard: "ui-network: frames' WebRTC denied", file: UI, find: r`console.warn("[ui-network] refused webrtc from a frame");
  return "deny";`, to: r`return "allow";`, what: "an agent-written frame opens a WebRTC connection", tests: tUI },
  { id: "U11", guard: "ui-network: frames origin with its slash", file: UI, find: "`${framesOrigin()}/`]", to: r`framesOrigin()]`, what: "(over-block) another host sharing the prefix counts as UI", tests: tUI },
  { id: "U12", guard: "ui-network: cut frames", file: UI, find: r`return !!e && (isUiFrame(e) || isUiDocument(e.ownerDocument));`, to: r`return !!e && isUiDocument(e.ownerDocument);`, what: "a cut frame's own navigation is not judged by its mark", tests: tUI },
  { id: "U13", guard: "ui-network: UI document walk", file: UI, find: r`if (UI_PREFIXES.some((p) => uri.startsWith(p))) return true;`, to: ``, what: "no document is recognised as the UI's by its address", tests: tUI },
  { id: "U14", guard: "ui-network: opening observer judges", file: UI, e2e: "e2e/ui-network.e2e.ts", find: r`if (!isUiLoad(channel.loadInfo) || !isBlockedAddress(channel.URI.spec)) return;`, to: r`if (channel) return;`, what: "the opening observer does nothing", tests: tUI },
  { id: "U15", guard: "ui-network: install steps", file: UI, e2e: "e2e/ui-network-fail.e2e.ts", find: r`observer: step("observer", () => Services.obs.addObserver(openingObserver, "http-on-opening-request")),`, to: r`observer: step("observer", () => {}),`, what: "the observer is reported installed but never registered", tests: tUI },

  // ── V. keys relay (host/relay.ts)
  { id: "V1", guard: "relay: session token", file: RELAY, find: r`return x.length === y.length && timingSafeEqual(x, y);`, to: r`return true;`, what: "any bearer gets the real API key used for it", tests: tRelay },
  { id: "V2", guard: "relay: inference paths only", file: RELAY, find: r`else if (!RELAY_PATHS[session.kind].includes(pathname)) status = 404, reply(res, 404, "Introuvable");`, to: ``, what: "any API path is relayed with the key (files, batches, admin; Ollama /api/pull)", tests: tRelay },
  { id: "V3", guard: "relay: POST only", file: RELAY, find: r`else if (req.method !== "POST") status = 405, reply(res, 405, "Méthode non permise");`, to: ``, what: "GET / DELETE relayed with the key", tests: tRelay },
  { id: "V4", guard: "relay: token constant time", file: RELAY, find: r`return x.length === y.length && timingSafeEqual(x, y);`, to: r`return x.equals(y);`, what: "comparison no longer constant-time (same answers)", tests: tRelay },
  { id: "V5", guard: "relay: client credentials dropped", file: RELAY, find: r`const DROPPED = new Set(["authorization", "x-api-key", "host", "connection", "content-length", "cookie", "proxy-authorization",`, to: r`const DROPPED = new Set(["authorization", "host", "connection", "content-length", "proxy-authorization",`, what: "the container's own x-api-key / cookie headers go upstream", tests: tRelay },

  // ── W. private spaces and reads in the browser bridge (chrome/agent/bridge.ts)
  { id: "W1", guard: "bridge: private tabs never read", file: BRIDGE, find: r`if (privateTab(state, o)) throw new PrivateTab(id);`, to: ``, what: "a tab of a private space is read", tests: tBridge },
  { id: "W2", guard: "bridge: origin re-checked after the read", file: BRIDGE, find: r`if (originOf(tab(id).url) !== origin || originOf(browser.currentURI.spec) !== origin)
      throw new SiteChanged(id);`, to: ``, what: "a tab that changed site during the read gives its new page", tests: tBridge },
  { id: "W3", guard: "bridge: read only the origin the kernel checked", file: BRIDGE, find: r`if (expect !== undefined && originOf(String(expect)) !== origin) throw new SiteChanged(id);`, to: ``, what: "a tab already on another origin than the one granted is read", tests: tBridge },
  { id: "W4", guard: "bridge: private mirror", file: BRIDGE, find: r`const isPrivate = (o: Tab | undefined) => !!o && !internal(o) && privateTab(state, o);`, to: r`const isPrivate = (o: Tab | undefined) => !!o && !o;`, what: "the kernel is never told which tabs are private (current_page, activity)", tests: tBridge },

  // ── X. container hardening and network proof (container/workshop.ts)
  { id: "X1", guard: "workshop: session only if a direct connection is refused", file: WORK, find: r`if (probe.code !== 7) fail(`, to: r`if (probe.code < 0) fail(`, what: "a session starts although the web is directly reachable", tests: tWork },
  { id: "X2", guard: "workshop: rules must apply", file: WORK, find: r`if (apply.code !== 0) fail(`, to: r`if (apply.code < 0) fail(`, what: "(the probe remains) a failed rules install is ignored", tests: tWork },
  { id: "X3", guard: "workshop: no-new-privileges", file: WORK, find: r`"--security-opt", "no-new-privileges",
  "--pids-limit", "1024",`, to: r`"--pids-limit", "1024",`, what: "setuid binaries can raise privileges in the container", tests: tWork },
  { id: "X4", guard: "workshop: cap-drop ALL", file: WORK, find: r`"--cap-drop", "ALL",
  // No setuid route`, to: r`// No setuid route`, what: "the container keeps default capabilities (NET_ADMIN under Podman: flush the rules)", tests: tWork },
  { id: "X5", guard: "workshop: IPv6 off", file: WORK, find: r`"--sysctl", "net.ipv6.conf.all.disable_ipv6=1",`, to: ``, what: "IPv6 is on (the iptables rules are IPv4 only)", tests: tWork },
  { id: "X6", guard: "workshop: .ressac read-only", file: WORK, find: r`/.ressac:ro`, to: r`/.ressac`, what: "the agent rewrites its launch profiles, MCP config, accepted instructions", tests: tWork },
  { id: "X7", guard: "workshop: ports on 127.0.0.1", file: WORK, find: '"-p", `127.0.0.1:${ports}:${ports}`', to: '"-p", `${ports}:${ports}`', what: "the agent's ports are published on every interface of the Mac", tests: tWork },
  { id: "X8", guard: "workshop: autoupdater off", file: WORK, find: r`"-e", "DISABLE_AUTOUPDATER=1",`, to: ``, what: "Claude Code's autoupdater is on", tests: tWork },
  { id: "X9", guard: "workshop: pids limit", file: WORK, find: r`"--pids-limit", "1024",`, to: ``, what: "no process limit (fork bomb)", tests: tWork },
  { id: "X10", guard: "workshop: memory limit", file: WORK, find: r`"--memory", String(this.memory()),`, to: ``, what: "no memory limit on the agent's container", tests: tWork },
  { id: "X11", guard: "workshop: only valid domains reach the rules", file: WORK, find: r`domains: domains.filter(validDomain) }`, to: r`domains }`, what: "(the module filters again) kernel-side domain filter gone", tests: tWork },
  { id: "X12", guard: "workshop: proxy env", file: WORK, find: r`"-e", "NODE_USE_ENV_PROXY=1",`, to: ``, what: "(not a barrier) Node ignores the proxy: checks flags are pinned", tests: tWork },
];
