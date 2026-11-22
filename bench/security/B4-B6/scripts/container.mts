// B5 and B6, container side, against a running drv.mts (BENCH_TMP = its temp folder, state.json inside). Each case is a
// snippet run by the driver (its control port), with the driver's real kernel, workshop and relay. One JSON line per case
// on stdout, as in results/*.jsonl: {id, verdict: held|bypass|limit|info|not-run, what, evidence}.
//   tsx container.mts b5 > b5-container.jsonl ; tsx container.mts b6 > b6-container.jsonl
// Checks read structured values (exit codes printed as key=value lines, errno codes, parsed JSON), never mixed output.
import { readFileSync } from "node:fs";
import { homedir, networkInterfaces, userInfo } from "node:os";
import { join } from "node:path";

const group = process.argv[2];
if (group !== "b5" && group !== "b6") throw new Error("usage: container.mts b5|b6");
const tmp = process.env.BENCH_TMP ?? (() => { throw new Error("BENCH_TMP missing"); })();
const state = JSON.parse(readFileSync(join(tmp, "state.json"), "utf8"));
const repo = new URL("../../../..", import.meta.url).pathname.replace(/\/$/, "");
const lan = Object.values(networkInterfaces()).flat().filter((i) => i && !i.internal).map((i) => i!.address);
const pairs: [string, string][] = [[repo, "<repo>"], [tmp, "<bench-tmp>"], [process.env.LIMA_HOME ?? "\0", "<lima-home>"], [process.env.RESSAC_ROOT ?? "\0", "<ressac-root>"], [homedir(), "<mac-home>"], [userInfo().username, "<user>"], ...lan.map((a): [string, string] => [a, "<mac-lan>"])];
const scrub = (s: string) => pairs.filter(([k]) => k.length > 3).sort((a, b) => b[0].length - a[0].length).reduce((t, [k, v]) => t.split(k).join(v), s);
const log = (...a: unknown[]) => console.error(new Date().toISOString().slice(11, 19), ...a);

/** Runs `body` in the driver as an async function of `ctx` (plus the helpers below); returns its JSON value. */
const PRE = `const kv=s=>Object.fromEntries(String(s).split('\\n').map(l=>/^([A-Za-z0-9_.-]+)=(.*)$/.exec(l.trim())).filter(Boolean).map(m=>[m[1],m[2].trim()]));
const nx=async c=>{const r=await ctx.x(c);return {...kv(r.stdout),_code:r.code}};
const cp=await import('node:child_process');
const root=c=>{const r=cp.spawnSync(ctx.tools.podman,[...ctx.machine.args(),'exec','-u','root',ctx.k.containerName(),'sh','-c',c],{encoding:'utf8'});return kv(r.stdout)};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));`;
async function ctl(body: string, timeoutMs = 240_000): Promise<any> {
  const r = await fetch(`http://127.0.0.1:${state.control}`, { method: "POST", body: `${PRE}\n${body}`, signal: AbortSignal.timeout(timeoutMs) });
  const t = await r.text();
  if (r.status !== 200) throw new Error(t.slice(0, 600));
  return JSON.parse(t);
}
type V = "held" | "bypass" | "limit" | "info" | "not-run";
async function run(id: string, what: string, body: string, judge: (e: any) => V) {
  log(id);
  let line: { id: string; verdict: V; what: string; evidence: unknown };
  try {
    const evidence = await ctl(body);
    line = { id, verdict: judge(evidence), what, evidence };
  } catch (e) {
    line = { id, verdict: "not-run", what, evidence: { runnerError: String((e as Error).message).slice(0, 600) } };
  }
  console.log(scrub(JSON.stringify(line)));
}
const no0 = (o: Record<string, string>, keys: string[]) => keys.every((k) => o[k] !== undefined && o[k] !== "0");

if (group === "b5") {
  await run("5.1.1", "as node: append, delete, rename over, chmod, chown the managed files; create beside them; rename their folders",
    `return await nx(\`for f in /etc/claude-code/managed-settings.json /etc/codex/requirements.toml; do n=$(basename $f); echo x >> $f 2>/dev/null; echo append_$n=$?; rm -f $f 2>/dev/null; echo rm_$n=$?; echo '{}' > /tmp/b5 && mv -f /tmp/b5 $f 2>/dev/null; echo mvover_$n=$?; chmod 666 $f 2>/dev/null; echo chmod_$n=$?; chown node $f 2>/dev/null; echo chown_$n=$?; ln -sf /tmp/b5x $f 2>/dev/null; echo symlink_$n=$?; echo x > /proc/self/root$f 2>/dev/null; echo procroot_$n=$?; echo owner_$n=$(stat -c %u:%a $f); done
for d in /etc/claude-code /etc/codex; do n=$(basename $d); touch $d/b5-new 2>/dev/null; echo beside_$n=$?; mv $d $d.b5 2>/dev/null; echo mvdir_$n=$?; done\`)`,
    (e) => {
      const ops = Object.keys(e).filter((k) => /^(append|rm|mvover|chmod|chown|symlink|procroot|beside|mvdir)_/.test(k));
      return ops.length === 18 && ops.every((k) => e[k] !== "0") && e["owner_managed-settings.json"] === "0:644" && e["owner_requirements.toml"] === "0:644" ? "held" : "bypass";
    });
  await run("5.1.2", "routes to root as node: su, sudo, setuid binaries, capabilities, no_new_privs, writable folders on PATH",
    `return await nx(\`su -s /bin/sh -c 'id -u' root </dev/null >/dev/null 2>&1; echo su=$?; command -v sudo >/dev/null && { sudo -n true 2>/dev/null; echo sudo=$?; } || echo sudo=absent
echo setuid=$(find / -xdev -perm -4000 -type f 2>/dev/null | wc -l); grep -E '^(CapEff|CapBnd|NoNewPrivs|Seccomp):' /proc/self/status | sed 's/:[[:space:]]*/=/'
w=; for d in $(echo $PATH | tr : ' '); do [ -w "$d" ] && w="$w $d"; done; echo writablePath=$w\`)`,
    (e) => (e.su !== "0" && e.sudo !== "0" && /^0+$/.test(e.CapEff) && /^0+$/.test(e.CapBnd) && e.NoNewPrivs === "1" && e.writablePath === "" ? "held" : "bypass"));
  await run("5.1.3", "the real restrictCodex write: content, owner, mode; a file planted where its temp file goes",
    `await ctx.workshop.restrictCodex('http://host.docker.internal:1/mcp');
     const n=await nx("echo owner=$(stat -c %u:%a /etc/codex/requirements.toml); echo mcp=$(grep -c host.docker.internal:1/mcp /etc/codex/requirements.toml); touch /etc/codex/requirements.toml.123 2>/dev/null; echo plant=$?");return n`,
    (e) => (e.owner === "0:644" && Number(e.mcp) >= 1 && e.plant !== "0" ? "held" : "bypass"));
  await run("5.1.5", "the binaries cannot replace themselves: claude/codex packages root-owned, npm i -g of a local package fails",
    `return await nx(\`for b in claude codex; do t=$(readlink -f $(command -v $b)); echo own_$b=$(stat -c %u $t); echo x >> $t 2>/dev/null; echo w_$b=$?; done
mkdir -p /tmp/b5pkg && echo '{"name":"b5pkg","version":"1.0.0"}' > /tmp/b5pkg/package.json && npm install -g --offline --no-audit --no-fund /tmp/b5pkg >/tmp/b5npm.log 2>&1; echo npmg=$?; echo eacces=$(grep -c EACCES /tmp/b5npm.log)\`)`,
    (e) => (e.own_claude === "0" && e.own_codex === "0" && no0(e, ["w_claude", "w_codex", "npmg"]) ? "held" : "bypass"));
  await run("5.2.1", "as node under /workspace/.ressac: write, delete, rename, mkdir, symlink, hardlink, /proc/self/root path, the notebook; the logs folder writable",
    `return await nx(\`cd /workspace/.ressac; echo ls=$(ls -A | tr '\\n' ,); echo x >> mcp.json 2>/dev/null; echo write=$?; rm -f mcp.json 2>/dev/null; echo rm=$?; mv mcp.json m2 2>/dev/null; echo mv=$?; mkdir b5d 2>/dev/null; echo mkdir=$?; ln -s /etc b5l 2>/dev/null; echo symlink=$?; ln mcp.json /workspace/b5hl 2>/dev/null; echo hardlink=$?; echo x >> /proc/self/root/workspace/.ressac/mcp.json 2>/dev/null; echo procroot=$?
nb=$(ls -d notes* notebook* 2>/dev/null | head -1); [ -n "$nb" ] && { echo x >> "$nb" 2>/dev/null; echo notebook=$?; } || echo notebook=absent
cd /; mv /workspace/.ressac /workspace/b5moved 2>/dev/null; echo mvmount=$?; echo x > /workspace/.ressac/logs/b5 && rm /workspace/.ressac/logs/b5; echo logs=$?\`)`,
    (e) => (no0(e, ["write", "rm", "mv", "mkdir", "symlink", "hardlink", "procroot", "mvmount"]) && e.notebook !== "0" && e.logs === "0" ? "held" : "bypass"));
  await run("5.2.4", "known limit: the main mcp.json, with its bearer token, is readable by node",
    `return await nx("grep -c Bearer /workspace/.ressac/mcp.json | sed 's/^/bearerLines=/'")`,
    (e) => (Number(e.bearerLines) > 0 ? "limit" : "info"));
  await run("5.4.1-5.4.2", "the instruction gate: after a baseline, change AGENTS.md, plant a link at a guide, swap the guides folder for a link, hardlink, reset mtime after a change, a fifo; Codex's ~/.codex/AGENTS.md; pending() must list each, revert restores AGENTS.md",
    `const base=await ctx.review.pending('claude');await ctx.review.keep('claude',base.snapshot);const cb=await ctx.review.pending('codex');await ctx.review.keep('codex',cb.snapshot);
     const before=(await ctx.x('cat /workspace/AGENTS.md')).stdout;
     await ctx.x(\`cd /workspace && echo MARK-GATE-$(date +%s%N) >> AGENTS.md && t=$(mktemp) && cp guides/extensions.md $t && ln -sf /etc/passwd guides/widgets.md && touch -r guides/actions.md /tmp/ref && echo MARK-GATE-$(date +%s%N) >> guides/actions.md && touch -r /tmp/ref guides/actions.md && rm guides/site-apps.md && mkfifo guides/site-apps.md && mkdir -p /home/node/.codex && echo MARK-GATE-$(date +%s%N) > /home/node/.codex/AGENTS.md; echo done\`);
     const p=await ctx.review.pending('claude');const pc=await ctx.review.pending('codex');
     await ctx.review.revert('claude',p.snapshot);const after=(await ctx.x('cat /workspace/AGENTS.md')).stdout;
     await ctx.x('cd /workspace && rm -f guides/widgets.md guides/site-apps.md');await ctx.review.revert('claude',(await ctx.review.pending('claude')).snapshot);
     const linkDir=await (async()=>{await ctx.x('cd /workspace && mv guides /tmp/guides-real && mkdir -p /tmp/g2 && cp /tmp/guides-real/* /tmp/g2/ && echo MARK-GATE >> /tmp/g2/extensions.md && ln -s /tmp/g2 guides');const q=await ctx.review.pending('claude');await ctx.x('cd /workspace && rm guides && mv /tmp/guides-real guides');return q.changes.map(c=>c.path+':'+c.status+(c.marker?':'+c.marker.replace(/\\u0000/g,''):''))})();
     await ctx.x('cd /home/node/.codex && mv AGENTS.md /tmp/b5-codex-agents.md');await ctx.review.keep('codex',(await ctx.review.pending('codex')).snapshot);
     return {claude:p.changes.map(c=>c.path+':'+c.status+(c.marker?':'+c.marker.replace(/\\u0000/g,''):'')),codex:pc.changes.map(c=>c.path+':'+c.status),revertRestoredAgents:after===before,linkedGuidesFolder:linkDir}`,
    (e) => {
      const has = (l: string[], p: string) => l.some((c) => c.startsWith(p + ":"));
      const ok = ["/workspace/AGENTS.md", "/workspace/guides/widgets.md", "/workspace/guides/actions.md", "/workspace/guides/site-apps.md"].every((p) => has(e.claude, p)) && has(e.codex, "/home/node/.codex/AGENTS.md") && e.revertRestoredAgents && e.linkedGuidesFolder.length > 0;
      return ok ? "held" : "bypass";
    });
  await run("5.4.4", "plant.sh's markers (CLAUDE.md variants, rules, skills, commands, agents, settings hooks/statusLine/apiKeyHelper/env, .mcp.json, ~/.claude.json servers, output style, auto-memory), then a Navigateur Claude session opened by the kernel on the fake API: no marker in any request, no marker file",
    `const plant=${JSON.stringify(readFileSync(new URL("./plant.sh", import.meta.url), "utf8"))};
     const pl=await ctx.x(plant);
     const eng=ctx.claudeEngineEnv({kind:'api',ollamaUrl:'',ollamaModel:'',apiUrl:'http://127.0.0.1:'+ctx.apiPort,apiModel:'bench-model'},{url:ctx.relay.containerUrl,token:ctx.relay.openSession('http://127.0.0.1:'+ctx.apiPort,'claude')});
     const n0=ctx.apiSeen.length;
     const s=await ctx.kernel.openAgentSession({cols:100,rows:30,window:'w-b5',mode:'browser',profile:'claude',extra:eng,review:async()=>'keep'});ctx.sessions.push(s);
     for(let i=0;i<120&&!ctx.apiSeen.slice(n0).some(r=>r.url.startsWith('/v1/messages')&&r.body.length>2000);i++){if(i===8)s.write('bench probe');if(i===9||i%20===19)s.write('\\r');await sleep(1000)}
     await sleep(3000);
     const reqs=ctx.apiSeen.slice(n0).filter(r=>r.url.startsWith('/v1/messages'));const all=reqs.map(r=>r.body).join('\\n');
     const markers=[...new Set(all.match(/MARK-[A-Z-]+/g)||[])];
     const files=(await ctx.x('ls /tmp/ | grep ^MARK- | tr "\\\\n" ,')).stdout.trim();
     const tools=[...new Set(reqs.flatMap(r=>{try{return (JSON.parse(r.body).tools||[]).map(t=>t.name)}catch{return []}}))];
     await s.stop?.().catch(()=>{});
     // Control: the typed probe line is in the requests read, so a marker would have been seen there too.
     return {planted:pl.stdout.trim(),requests:reqs.length,typedTextSeen:all.includes('bench probe'),markersInRequests:markers,markerFiles:files,toolsHaveBash:tools.includes('Bash'),toolCount:tools.length}`,
    (e) => (e.planted !== "planted" || e.requests === 0 || !e.typedTextSeen ? "not-run" : e.markersInRequests.length === 0 && e.markerFiles === "" && !e.toolsHaveBash ? "held" : "bypass"));
  await run("5.4.4-control", "control for 5.4.4: the same planted markers, through a plain `claude -p` with none of the kernel's Navigateur flags or env, do reach the fake API (else 5.4.4 would be blind)",
    `const eng=ctx.claudeEngineEnv({kind:'api',ollamaUrl:'',ollamaModel:'',apiUrl:'http://127.0.0.1:'+ctx.apiPort,apiModel:'bench-model'},{url:ctx.relay.containerUrl,token:ctx.relay.openSession('http://127.0.0.1:'+ctx.apiPort,'claude')});
     const n0=ctx.apiSeen.length;
     await ctx.workshop.exec(['env',...Object.entries(eng.env).map(([k,v])=>k+'='+v),'sh','-c','cd /workspace && timeout 60 claude -p "bench probe" >/dev/null 2>&1; true']);
     const all=ctx.apiSeen.slice(n0).filter(r=>r.url.startsWith('/v1/messages')).map(r=>r.body).join('\\n');
     return {markers:[...new Set(all.match(/MARK-[A-Z-]+/g)||[])].sort()}`,
    (e) => (e.markers.includes("MARK-AUTO-MEMORY") && e.markers.includes("MARK-PROJECT-CLAUDE-MD") ? "info" : "not-run"));
  await run("5.4.6", "Codex in Navigateur (cx.sh, the kernel's codex exec arguments) with ~/.codex/instructions.md, memories, prompts and hooks.json planted: no shell tool, no marker reaches the fake API, no hook ran",
    `await ctx.x(\`mkdir -p ~/.codex/memories ~/.codex/prompts && echo MARK-CODEX-INSTRUCTIONS > ~/.codex/instructions.md && echo MARK-CODEX-MEMORY > ~/.codex/memories/m.md && echo MARK-CODEX-PROMPT > ~/.codex/prompts/p.md && echo '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"touch /tmp/MARK-CODEX-HOOK"}]}]}}' > ~/.codex/hooks.json; echo ok\`);
     const tok=ctx.relay.openSession('http://127.0.0.1:'+ctx.apiPort,'codex');const n0=ctx.apiSeen.length;
     const cx=${JSON.stringify(readFileSync(new URL("./cx.sh", import.meta.url), "utf8"))};
     const r=await ctx.workshop.exec(['env','ENGINE_TOKEN='+tok,'MCP_PORT='+ctx.kernel.mcpPort,'RELAY_PORT='+ctx.relay.port,'sh','-c',cx]);
     const reqs=ctx.apiSeen.slice(n0).filter(q=>q.url.startsWith('/responses'));const all=reqs.map(q=>q.body).join('\\n');
     const tools=[...new Set(reqs.flatMap(q=>{try{return (JSON.parse(q.body).tools||[]).map(t=>t.name||t.type)}catch{return []}}))];
     const files=(await ctx.x('ls /tmp/ | grep ^MARK- | tr "\\\\n" ,')).stdout.trim();
     return {requests:reqs.length,markers:[...new Set(all.match(/MARK-CODEX-[A-Z-]+/g)||[])],markerFiles:files,tools,shellTool:tools.some(t=>/shell|exec_command|local_shell/.test(t))}`,
    (e) => (e.requests === 0 ? "not-run" : e.markers.length === 0 && e.markerFiles === "" && !e.shellTool ? "held" : "bypass"));
  await run("5.5.1-5.5.2", "npm install scripts: off by default (a local package's postinstall does not run); the stated limit, a project .npmrc with ignore-scripts=false, turns them on",
    `return await nx(\`echo cfg=$(npm config get ignore-scripts); rm -rf /tmp/b5s /tmp/MARK-NPM*; mkdir -p /tmp/b5s/dep /tmp/b5s/app && cd /tmp/b5s && echo '{"name":"dep","version":"1.0.0","scripts":{"postinstall":"touch /tmp/MARK-NPM-POSTINSTALL"}}' > dep/package.json && cd app && echo '{"name":"app","version":"1.0.0"}' > package.json && npm install --offline --no-audit --no-fund ../dep >/dev/null 2>&1; echo inst=$?; [ -e /tmp/MARK-NPM-POSTINSTALL ] && echo ran=1 || echo ran=0
rm -rf node_modules package-lock.json; echo ignore-scripts=false > .npmrc; npm install --offline --no-audit --no-fund ../dep >/dev/null 2>&1; [ -e /tmp/MARK-NPM-POSTINSTALL ] && echo ranNpmrc=1 || echo ranNpmrc=0\`)`,
    (e) => (e.inst !== "0" ? "not-run" : e.cfg === "true" && e.ran === "0" ? (e.ranNpmrc === "1" ? "limit" : "held") : "bypass"));
} else {
  const RQ = `const relayUrl='http://host.docker.internal:'+ctx.relay.port;
const rawJs="const s=require('net').connect(Number(process.argv[2]),'host.docker.internal',()=>s.write(process.argv[1]));let d='';s.on('data',x=>d+=x);s.on('error',e=>d='error '+e.code);s.on('close',()=>console.log('status='+(d.startsWith('HTTP/1.1 ')?d.slice(9,12):'none')))";
const req=async(tok,path,{method='POST',raw}={})=>{if(raw){const r=await ctx.workshop.exec(['node','-e',rawJs,raw,String(ctx.relay.port)]);return kv(r.stdout).status}const c=\`curl -s --path-as-is -o /dev/null -w 'status=%{http_code}' -X \${method} -H "authorization: Bearer $1" -H 'content-type: application/json' -H 'anthropic-version: 2023-06-01' --data-binary '{"model":"bench","max_tokens":1,"messages":[{"role":"user","content":"bench"}]}' "\${relayUrl}\${path}"\`;
  const r=await ctx.workshop.exec(['sh','-c',c,'req',raw??tok]);return kv(r.stdout).status};
const target='http://127.0.0.1:'+ctx.apiPort;`;
  await run("6.0", "control: from the container, POST /v1/messages with a live session token reaches the fake upstream with the fake key swapped in, the token not forwarded",
    `${RQ}const t=ctx.relay.openSession(target,'claude');const n0=ctx.apiSeen.length;const st=await req(t,'/v1/messages');const up=ctx.apiSeen.slice(n0);
     return {status:st,upstreamCalls:up.length,keySwapped:up.length>0&&(up[0].headers['x-api-key']===ctx.KEY.claude||String(up[0].headers.authorization).includes(ctx.KEY.claude)),tokenForwarded:JSON.stringify(up).includes(t)}`,
    (e) => (e.upstreamCalls === 1 && e.keySwapped && !e.tokenForwarded ? "info" : "not-run"));
  await run("6.3.1-6.3.3", "with a live token from the container: other paths, path tricks, an absolute-form target, GET, a Claude token on the Codex path, a closed token, no token",
    `${RQ}const t=ctx.relay.openSession(target,'claude');const n0=ctx.apiSeen.length;const o={};
     for(const p of ['/v1/files','/v1/models','/v1/organizations/x/api_keys','/v1/messages/../files','/v1/messages/%2e%2e/models','//v1/messages','/V1/MESSAGES','/v1/messages;x','/responses','/'])o[p]=await req(t,p);
     o['GET /v1/messages']=await req(t,'/v1/messages',{method:'GET'});
     o.absoluteForm=await req(t,'',{raw:'POST http://evil.example/v1/messages HTTP/1.1\\r\\nHost: evil.example\\r\\nAuthorization: Bearer '+t+'\\r\\nContent-Length: 2\\r\\nConnection: close\\r\\n\\r\\n{}'});
     o.noToken=await req('','/v1/messages');o.wrongToken=await req('0'.repeat(64),'/v1/messages');
     const t2=ctx.relay.openSession(target,'claude');ctx.relay.closeSession(t2);o.closedToken=await req(t2,'/v1/messages');
     return {statuses:o,upstreamCalls:ctx.apiSeen.length-n0}`,
    (e) => {
      const s = e.statuses;
      const paths = ["/v1/files", "/v1/models", "/v1/organizations/x/api_keys", "/v1/messages/../files", "/v1/messages/%2e%2e/models", "//v1/messages", "/V1/MESSAGES", "/v1/messages;x", "/responses", "/"];
      const ok = paths.every((p) => s[p] === "404") && s["GET /v1/messages"] === "405" && ["noToken", "wrongToken", "closedToken"].every((k) => s[k] === "401") && /^\d{3}$/.test(String(s.absoluteForm)) && s.absoluteForm !== "200" && e.upstreamCalls === 0;
      return ok ? "held" : "bypass";
    });
  await run("6.1.2", "no key in the container: the session env, every readable /proc/*/environ, .ressac, the home volume, /workspace and /tmp hold neither fake key",
    `const k1=ctx.KEY.claude.slice(0,20),k2=ctx.KEY.codex.slice(0,20);
     const r=await ctx.x(\`i=0; for k in \${k1} \${k2}; do i=$((i+1)); n=0; env | grep -qF $k && n=$((n+1)); for f in /proc/[0-9]*/environ; do tr '\\\\0' '\\\\n' < $f 2>/dev/null | grep -qF $k && n=$((n+1)); done; grep -rlF $k /workspace /home/node /tmp 2>/dev/null | head -3 | sed 's/^/file=/'; echo hits_$i=$n; done; echo readableEnviron=$(cat /proc/[0-9]*/environ 2>/dev/null | wc -c)\`);
     return {...kv(r.stdout),files:r.stdout.split('\\n').filter(l=>l.startsWith('file=')).length}`,
    (e) => (e.hits_1 === undefined || e.hits_2 === undefined ? "not-run" : e.hits_1 === "0" && e.hits_2 === "0" && e.files === 0 ? "held" : "bypass"));
  await run("6.2.4-reach", "from the container: the fake upstream's Mac port (not allowed) and direct internet",
    `const r=await ctx.x(\`curl -s -o /dev/null --max-time 5 http://host.docker.internal:\${ctx.apiPort}/; echo api=$?; curl -s -o /dev/null --noproxy '*' --max-time 5 https://1.1.1.1; echo direct=$?\`);return kv(r.stdout)`,
    (e) => (e.api === "7" && e.direct === "7" ? "held" : e.api === "0" || e.direct === "0" ? "bypass" : "info"));
}
