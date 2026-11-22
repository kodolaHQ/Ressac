// B7 C7.1/C7.2 (decision), C7.5 (domain matching), C7.8 (CSP text), C7.9 (isBlockedAddress); B9 C9.2 (version logic), C9.5 (telemetry payloads).
import { writeFileSync } from "node:fs";
const R = new URL("../../../../apps/firefox", import.meta.url).pathname;
const rows: { id: string; input: string; outcome: string }[] = [];
const out = (id: string, input: string, outcome: unknown) => rows.push({ id, input, outcome: typeof outcome === "string" ? outcome : JSON.stringify(outcome) });

test("pure decisions", async () => {
  // ---- page guard
  const { agentPageDecision } = await import(`${R}/chrome/agent/page-guard.ts`);
  const ports: [number, number] = [5300, 5319];
  const from = "http://127.0.0.1:5300/app";
  const d = (to: string, o: Partial<{ document: boolean; gesture: boolean; method: string; from: string }> = {}) =>
    agentPageDecision({ from: o.from ?? from, to, document: o.document ?? false, gesture: o.gesture ?? false, method: o.method ?? "GET" }, ports);
  for (const to of ["https://evil.example/?d=x"]) for (const method of ["GET", "POST"]) out("A1", `${method} ${to}`, d(to, { method }));
  for (const to of ["http://127.0.0.1:5301/x", "http://localhost:5319/x", "http://[::1]:5300/x", "http://127.9.9.9:5300/x", "http://127.0.0.1:5320/x", "http://127.0.0.1:5299/x", "http://127.0.0.1:11434/api/pull", "http://127.0.0.1:5279/mcp-external", "http://127.0.0.1/x", "https://127.0.0.1:5300/x"]) out("A2", to, d(to));
  for (const to of ["http://127.0.0.1.nip.io:5300/", "http://0.0.0.0:5300/", "http://[::ffff:127.0.0.1]:5300/", "http://2130706433:5300/", "http://0x7f.1:5300/", "http://localhost.:5300/", "http://127.0.0.1:5300@evil.example/", "http://192.168.1.10:5300/", "http://evil.example:5300/", "http://x.localhost:5300/", "http://[::]:5300/"]) out("A3", to, d(to));
  for (const to of ["https://cdn.jsdelivr.net/npm/x", "https://unpkg.com/x", "https://cdnjs.cloudflare.com/x", "https://fonts.googleapis.com/css", "https://fonts.gstatic.com/x", "https://cdn.jsdelivr.net.evil.example/", "https://evil.example/cdn.jsdelivr.net", "https://cdn.jsdelivr.net@evil.example/", "https://unpkg.com./x", "https://UNPKG.COM/x", "https://x.unpkg.com/x", "https://unpkg.com\\@evil.example/", "https://data.jsdelivr.com/x", "https://www.jsdelivr.net/x"]) out("A4", to, d(to));
  for (const method of ["POST", "PUT", "HEAD", "OPTIONS", "get", "DELETE"]) out("A5", `${method} https://unpkg.com/x`, d("https://unpkg.com/x", { method }));
  for (const to of ["http://unpkg.com/?d=secret", "http://unpkg.com:8080/?d=secret", "https://unpkg.com:8443/?d=secret", "http://cdn.jsdelivr.net/?d=secret"]) out("A6", `GET ${to}`, d(to));
  for (const to of ["ws://evil.example/", "wss://evil.example/", "ws://127.0.0.1:5300/", "wss://unpkg.com/", "ftp://evil.example/", "file:///etc/passwd", "data:text/html,x", "blob:http://127.0.0.1:5300/uuid", "mailto:a@b.c?body=secret", "slack://open?x=secret", "about:blank", "javascript:1", "not a url"]) out("A7", to, d(to));
  for (const f of ["https://evil.example:5300/", "http://evil.example:5310/", "http://127.0.0.1:5320/", "http://127.0.0.1/", "https://127.0.0.1:5300/", "about:blank", "", "null", "moz-nullprincipal:{x}?http://127.0.0.1:5300"]) out("A8", `from ${JSON.stringify(f)} -> GET https://evil.example/`, d("https://evil.example/", { from: f }));
  out("B1", "top-level, no gesture, to the web", d("https://evil.example/?d=x", { document: true }));
  out("B1", "top-level, gesture, GET to the web", d("https://evil.example/?d=x", { document: true, gesture: true }));
  out("B1", "top-level, gesture, POST to the web", d("https://evil.example/", { document: true, gesture: true, method: "POST" }));
  out("B1", "top-level, gesture, to another local port (Ollama)", d("http://127.0.0.1:11434/", { document: true, gesture: true }));
  out("B1", "top-level, gesture, to a custom scheme", d("slack://x", { document: true, gesture: true }));
  out("B1", "subresource with gesture flag, to the web", d("https://evil.example/", { gesture: true }));
  out("A28", "top-level, no gesture, started by a CDN-hosted document (from = https://unpkg.com)", d("https://evil.example/?d=x", { document: true, from: "https://unpkg.com/pkg/x.html" }));

  // ---- site apps: domain matching
  const { decisionNavigation, openDecision } = await import(`${R}/core/sites/navigation.ts`);
  const ctx = { domains: ["app.example"], login: ["login.example"] };
  for (const u of ["https://app.example/", "https://sub.app.example/x", "https://APP.EXAMPLE./", "https://app.example:8443/", "http://app.example/", "https://app.example.evil.test/", "https://evilapp.example/", "https://app.example@evil.test/", "https://evil.test/app.example", "https://evil.test#app.example", "https://evil.test\\@app.example/", "https://app.example\\@evil.test/x", "https://аpp.example/", "https://xn--pp-6kc.example/", "https://login.example/oauth", "https://x.login.example/", "ftp://app.example/", "javascript:alert(1)", "data:text/html,x", "blob:https://app.example/uuid", "view-source:https://app.example/", "about:blank", "file:///etc/hosts", "https://user:pw@app.example/", "https://127.0.0.1/", "https://app.example%2eevil.test/"])
    out("E1-3", u, `${decisionNavigation(u, ctx)} / open: ${openDecision(u, ctx)}`);
  for (const [dom, u] of [["github.io", "https://attacker.github.io/"], ["co.uk", "https://evil.co.uk/"], ["com", "https://evil.com/"], ["", "https://evil.com/"], ["*", "https://evil.com/"], ["app.example/", "https://evil.com/"], [".example", "https://evil.example/"]] as const)
    out("E4", `declared ${JSON.stringify(dom)} -> ${u}`, decisionNavigation(u, { domains: [dom], login: [] }));

  // ---- UI network
  (globalThis as any).window = undefined;
  const ui = await import(`${R}/chrome/store/ui-network.ts`).catch((e) => ({ error: String(e) }) as any);
  if (ui.isBlockedAddress) for (const u of ["http://x/", "https://x/", "HTTPS://x/", "ws://x/", "wss://x/", "view-source:https://x/", "view-source:view-source:http://x/", "VIEW-SOURCE:https://x/", "jar:https://x/a.zip!/b", "moz-remote-image://?url=https%3A%2F%2Fx%2F", "about:reader?url=https%3A%2F%2Fx%2F", "page-icon:https://x/", "moz-page-thumb://thumbnails/?url=https%3A%2F%2Fx", "cached-favicon:https://x/favicon.ico", "blob:https://x/uuid", "data:text/html,<img src=https://x/>", "ftp://x/", "file:///etc/hosts", "mailto:a@b.c", "resource://gre/", "chrome://browser/content/", "moz-extension://uuid/x", " https://x/", "feed:https://x/"])
    out("I1", u, ui.isBlockedAddress(u) ? "blocked" : "passes");
  else out("I1", "import", ui.error);

  // ---- widget CSP text
  const wf = await import(`${R}/chrome/window/widget-frame.ts`).catch((e) => ({ error: String(e) }) as any);
  out("H1", "CSP_WIDGET", wf.CSP_WIDGET ?? wf.error);

  // ---- update version logic. Services.vc.compare stand-in: Mozilla's comparator on dotted numbers (numeric parts only).
  const { isStaleUpdate, plistVersion, isSignatureFailure } = await import(`${R}/core/update.ts`);
  const cmp = (a: string, b: string) => { const x = a.split(".").map(Number), y = b.split(".").map(Number); for (let i = 0; i < Math.max(x.length, y.length); i++) { const p = (x[i] ?? 0) - (y[i] ?? 0); if (p) return Math.sign(p); } return 0; };
  for (const [phase, v] of [["ready", "0.1.18"], ["ready", "0.1.17"], ["ready", "0.1.9"], ["ready", "0.1.19"], ["ready", "0.1.100"], ["ready", null], ["ready", ""], ["downloading", "0.1.17"], ["idle", "0.1.17"], ["checking", "0.1.17"], ["failed", "0.1.17"]] as const)
    out("L1", `running 0.1.18, offered ${JSON.stringify(v)} in phase ${phase}`, isStaleUpdate(phase, v, "0.1.18", cmp) ? "stale: dropped" : "kept");
  const plist = (v: string) => `<plist><dict><key>CFBundleShortVersionString</key>\n\t<string>${v}</string></dict></plist>`;
  out("L1", "plist 0.1.17", plistVersion(plist("0.1.17")));
  out("L1", "empty plist (no Updated.app)", plistVersion(""));
  out("L1", "plist with two version keys", plistVersion(plist("9.9.9") + plist("0.1.1")));
  out("L1", "binary plist (bplist00…)", plistVersion("bplist00Ô\u0001CFBundleShortVersionStringU0.1.1"));
  out("L1", "signature error codes 16..24", [16, 17, 19, 23, 24].map((c) => `${c}:${isSignatureFailure(c)}`).join(" "));

  // ---- telemetry
  const T = await import(`${R}/shared/telemetry.ts`);
  const home = "/Users/marie";
  const posts: { url: string; body: string }[] = [];
  const post = async (url: string, body: string) => void posts.push({ url, body });
  const DSN = "https://publickey@sentry.invalid/42";
  const env = (e: any) => JSON.parse(T.errorEnvelope(e, { release: "0.1.18", home, eventId: "e".repeat(32), now: new Date("2026-11-21T00:00:00Z") }).split("\n")[2]);
  // P1
  out("P1", "error envelope (3 lines)", T.errorEnvelope({ source: "chrome", type: "TypeError", message: "x is undefined", stack: "f@chrome://browser/content/ressac/store.sys.mjs:10:5" }, { release: "0.1.18", home, eventId: "e".repeat(32), now: new Date("2026-11-21T00:00:00Z") }));
  out("P1", "session envelope (3 lines)", T.sessionEnvelope({ release: "0.1.18", installId: "INSTALL-UUID", sessionId: "SESSION-UUID", now: new Date("2026-11-21T00:00:00Z") }));
  out("P1", "endpoints", T.parseDsn(DSN));
  // P2 addresses
  const S = (t: string) => T.scrub(t, home);
  for (const t of [
    "failed https://mail.example.com/inbox?user=marie#x", "failed http://192.168.1.12:8080/admin", "ws://chat.example/room/42", "WSS://CHAT.EXAMPLE/room", "file:///Users/marie/Documents/impots.pdf", "blob:https://bank.example/uuid", "data:text/plain;base64,c2VjcmV0",
    "view-source:https://bank.example/compte", "ftp://files.example/secret.txt", "moz-extension://1b2c/popup.html?tab=bank", "about:reader?url=https%3A%2F%2Fbank.example%2Fcompte%2F12345", "https%3A%2F%2Fbank.example%2Fcompte%2F12345",
    "bank.example/compte/12345?iban=FR76", "host bank.example refused", "192.168.1.12:8080", "marie.dupont@example.fr", "mailto:marie.dupont@example.fr", "url_https://bank.example/x", "x=https://bank.example/x", "https://bank.example/mes comptes/12345",
    "https://fr.wiki.example/Compte_(marie)/secret", "{\"url\":\"https:\\/\\/bank.example\\/compte\"}", "chrome://browser/content/ressac/x.js", "resource://ressac-frames-abcdef0123456789/widgets/meteo/index.html", "sftp://marie@nas.local/prive", "tel:+33612345678", "magnet:?xt=urn:btih:abc",
    "Domaine non déclaré : intranet.client-secret.example", "Adresse locale refusée : nas.local (192.168.1.12)",
  ]) out("P2", t, S(t));
  // P3 home
  for (const [h, t] of [
    [home, "/Users/marie/Ressac/x.ts"], [home, "/Users/marie"], [home + "/", "/Users/marie/x"], [home, "/Users/marieX/x"], [home, "/Users/marie.bak/x"], [home, "/Users/marie-pro/x"], [home, "/users/marie/x"], [home, "/USERS/MARIE/x"],
    ["/Users/andré", "/Users/andré/x (decomposed accent)"], ["/Users/marie dupont", "/Users/marie%20dupont/x"], [home, "\\/Users\\/marie\\/x"], [home, "/Volumes/Data/Users/marie/x"], [home, "/System/Volumes/Data/Users/marie/x"],
    [home, "user marie logged"], [home, "/Volumes/ClientSecret/contrat-acme.pdf"], [home, "/Users/marie/Ressac/Espace Banque/projet-divorce/app.js"], [home, "/private/var/folders/ab/cd/T/ressac-marie/x"], [home, "~marie/x"], [home, "/Users/Shared/marie/x"], ["", "/Users/marie/x (home unknown)"],
  ] as const) out("P3", `home=${JSON.stringify(h)}  ${t}`, T.scrub(t, h));
  // P4 quoted spans (the message field)
  const M = (m: string) => env({ source: "host", type: "Error", message: m }).exception.values[0].value;
  for (const m of [
    'unexpected "motdepasse123" here', "open 'secret.pdf' failed", "bad `token-abc`", "refus de « dossier-secret »", "Impossible d'ouvrir 'contrat-acme.pdf'", "can't read 'contrat-acme.pdf'", "l'utilisateur n'a pas accès à 'contrat-acme.pdf'",
    "bad “contrat-acme” value", "bad ‘contrat-acme’ value", 'bad "contrat\nacme" value', 'bad "contrat-acme value', "bad (contrat-acme) value", "bad <contrat-acme> value", "bad contrat-acme value",
    "Unexpected token 'h', \"hello wor\"... is not valid JSON", "ENOENT: no such file or directory, open '/Users/marie/Ressac/Banque/releve.csv'", "ENOENT: no such file or directory, open /Users/marie/Ressac/Banque/releve.csv",
    "x".repeat(290) + " SECRET-AFTER-300",
  ]) out("P4", m.length > 120 ? m.slice(0, 20) + "…(" + m.length + " chars)" : m, M(m));
  // P5 stack, P6 type
  const stack = ["f@chrome://browser/content/ressac/store.sys.mjs:10:5", "g@https://bank.example/compte/12345/app.js:1:2", "h@file:///Users/marie/Ressac/Banque/app.js:3:4", "    at lireReleveDeMarie (/Users/marie/Ressac/Banque/releve.js:5:6)", "    at /Volumes/ClientSecret/x.js:7:8",
    "k@/users/marie/x.js:1:1", "anonymous@moz-extension://1b2c/bg.js line 3 > eval:1:1", "m@bank.example/app.js:1:1", "    at Object.<anonymous> (node:internal/x:1:1)", "    at async secretFunctionName (webpack://marie-projet/./src/secret.ts:1:1)"].join("\n");
  out("P5", "frames kept", env({ source: "host", type: "Error", message: "m", stack }).exception.values[0].stacktrace.frames);
  out("P5", "60 frames in -> frames out", env({ source: "host", type: "Error", message: "m", stack: Array.from({ length: 60 }, (_, i) => `f${i}@chrome://x/y.js:${i}:1`).join("\n") }).exception.values[0].stacktrace.frames.length);
  out("P6", "type holding private text", env({ source: "host", type: "Error in 'contrat-acme.pdf' at https://bank.example/x for marie.dupont@example.fr", message: "m" }).exception.values[0].type);
  // P7 before the notice / P8 the switch
  let on = false;
  const ids: Record<string, string | undefined> = { id: "OLD-ID" };
  const rep = T.createReporter({ dsn: DSN, release: "0.1.18", home, enabled: () => on, post });
  rep.report({ source: "chrome", type: "Error", message: "early error" });
  T.launchSession({ dsn: DSN, release: "0.1.18", enabled: () => on, post, ids: { get: () => ids.id, set: (v: string) => (ids.id = v), clear: () => (ids.id = undefined) }, newId: () => "NEW-ID" });
  out("P7", "not consented: one error + the launch session", `posts=${posts.length}, install id=${ids.id}`);
  on = true;
  rep.report({ source: "chrome", type: "Error", message: "early error" });
  out("P7", "consent given later: the SAME early error reported again", `posts=${posts.length} (the refused report was not remembered as seen: ${posts.length === 1})`);
  T.launchSession({ dsn: DSN, release: "0.1.18", enabled: () => on, post, ids: { get: () => ids.id, set: (v: string) => (ids.id = v), clear: () => (ids.id = undefined) }, newId: () => "NEW-ID" });
  out("P9", "session after consent", posts.at(-1)!.body.split("\n")[2]!);
  out("P9", "session URL", posts.at(-1)!.url);
  on = false;
  const n = posts.length;
  rep.report({ source: "chrome", type: "Error", message: "after switch off" });
  out("P8", "switch off mid-session: next error", `posts added=${posts.length - n}`);
  on = true;
  const n2 = posts.length;
  for (let i = 0; i < 100; i++) rep.report({ source: "chrome", type: "Error", message: `distinct ${i}` });
  out("P8", "100 distinct errors in one launch", `posts added=${posts.length - n2}`);
  const rep2 = T.createReporter({ dsn: "", release: "x", home, enabled: () => true, post });
  const n3 = posts.length;
  rep2.report({ source: "chrome", type: "Error", message: "no dsn" });
  out("P10", "no DSN", `posts added=${posts.length - n3}`);
  for (const dsn of ["https://k@evil.example/1", "http://k@127.0.0.1:9000/1", "https://k@sentry.invalid/1/extra", "https://sentry.invalid/1", "javascript://k@x/1"]) out("P10", `DSN ${dsn}`, T.parseDsn(dsn) ?? "rejected");

  writeFileSync(new URL("./results/pure.json", import.meta.url), JSON.stringify(rows, null, 1));
}, 60_000);
