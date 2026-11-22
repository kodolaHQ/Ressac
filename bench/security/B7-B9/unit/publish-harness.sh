#!/bin/zsh
# B9 C9.4 (N1-N6): scripts/publish.sh, byte-identical copy, run in dry-run inside a scratch tree with test keys.
# Usage: publish-harness.sh <scratch dir holding db.der db2.der signed.mar unsigned.mar foreign.mar t-content.mar (from the signmar run)> 
# Nothing is uploaded: dry-run prints the wrangler commands; the one non-dry run (N5) has npx, git and curl replaced by failing shims.
set -u
MARS=$1
REPO=${RESSAC_WORKTREE:-$(cd "$(dirname "$0")/../../../.." && pwd)}/apps/firefox
OBJ=${RESSAC_ENGINE_OBJ:?set RESSAC_ENGINE_OBJ to a built engine obj-aarch64-apple-darwin folder}
T=$MARS/../pub; rm -rf $T; mkdir -p $T/app/{scripts,dist,shared,src/toolkit/mozapps/update/updater,engine} $T/www $T/shims
cp $REPO/scripts/publish.sh $REPO/scripts/update-xml.mjs $T/app/scripts/
cmp -s $REPO/scripts/publish.sh $T/app/scripts/publish.sh && echo "publish.sh copy is byte-identical ($(shasum -a 256 $REPO/scripts/publish.sh | cut -c1-16))"
ln -s $OBJ $T/app/engine/obj-aarch64-apple-darwin
cp $MARS/db.der $T/app/src/toolkit/mozapps/update/updater/dep1.der
cp $MARS/db2.der $T/app/src/toolkit/mozapps/update/updater/dep2.der
printf '[App]\nVersion=160.0.1\n' > $T/application.ini
KEY=benchbenchbenchbenchbench000
for s in npx git curl; do printf '#!/bin/sh\necho "SHIM %s called: $*" >&2\nexit 1\n' $s > $T/shims/$s; chmod +x $T/shims/$s; done
# The stand-in for updates.getressac.app: serves $T/www, 404 otherwise; a file named FAIL makes every answer a 500.
node -e '
const http=require("http"),fs=require("fs"),path=require("path");const root=process.argv[1];
const s=http.createServer((q,r)=>{if(fs.existsSync(root+"/FAIL")){r.writeHead(500);return r.end()}const f=path.join(root,new URL(q.url,"http://x").pathname);
 if(fs.existsSync(f)&&fs.statSync(f).isFile()){r.writeHead(200);r.end(fs.readFileSync(f))}else{r.writeHead(404);r.end()}}).listen(0,"127.0.0.1",()=>{fs.writeFileSync(root+"/../port",String(s.address().port))})' $T/www &
SRV=$!; trap "kill $SRV 2>/dev/null" EXIT
while [[ ! -s $T/port ]]; do sleep 0.1; done
HOST=http://127.0.0.1:$(cat $T/port)
FEED=$T/www/updates/$KEY/browser/Darwin_aarch64-gcc3/ressac

setup() { # version, mar file, [xml mar file], [xml version], [xml key]
  local v=$1 mar=$2 xmar=${3:-$2} xv=${4:-$1} xk=${5:-$KEY}
  rm -rf $T/app/dist/* $T/www/* ; mkdir -p $FEED
  print -r -- "{\"version\": \"$v\"}" > $T/app/package.json
  print -r -- "export const notes = [{ version: \"$v\" }];" > $T/app/shared/release-notes.ts
  print -r -- "dummy" > $T/app/dist/Ressac-$v.dmg
  cp $MARS/$mar $T/app/dist/Ressac-$v.mar
  node $T/app/scripts/update-xml.mjs $MARS/$xmar $T/application.ini $xv $xk 20261121000000 > $T/app/dist/update.xml
}
live() { print -r -- "<updates><update displayVersion=\"$1\"/></updates>" > $FEED/update.xml }
run() { # label
  local out rc
  out=$(RESSAC_PUBLISH_DRY_RUN=1 RESSAC_PUBLISH_SKIP_APPLE=1 RESSAC_PUBLISH_HOST=$HOST RESSAC_UPDATE_KEY=$KEY zsh $T/app/scripts/publish.sh 2>&1); rc=$?
  print -r -- "$1 -> rc=$rc: $(print -r -- "$out" | grep -E '^publish:|published|resuming' | tail -1 | sed "s#$T#<scratch>#g;s#$HOST#<host>#g") [uploads printed: $(print -r -- "$out" | grep -c '^wrangler')]"
}

setup 9.9.1 signed.mar; run "S0 control: signed MAR, nothing live"
setup 9.9.1 unsigned.mar; run "N1 unsigned MAR"
setup 9.9.1 foreign.mar; run "N1 MAR signed by the backup certificate's key (dep2 in this harness)"
cp $MARS/db.der $T/app/src/toolkit/mozapps/update/updater/dep2.der
setup 9.9.1 foreign.mar; run "N1 MAR signed by a key that is neither certificate"
setup 9.9.1 t-content.mar; run "N1 signed MAR, one content byte flipped"
setup 9.9.1 t-sig.mar; run "N1 signed MAR, one signature byte flipped"
setup 9.9.1 two.mar; run "N1 MAR with two signatures (ours + foreign)"
setup 9.9.1 signed.mar; live 9.9.2; run "N2 live feed 9.9.2, publishing 9.9.1"
setup 9.9.1 signed.mar; live 9.9.1; run "N2 live feed 9.9.1, publishing 9.9.1 (same version, feed only)"
setup 9.9.1 signed.mar; live 9.9.0; run "N2 live feed 9.9.0, publishing 9.9.1"
setup 0.1.10 signed.mar; live 0.1.9; run "N2 live feed 0.1.9, publishing 0.1.10"
setup 0.1.9 signed.mar; live 0.1.10; run "N2 live feed 0.1.10, publishing 0.1.9"
setup 9.9.1 signed.mar; print -r -- "<updates/>" > $FEED/update.xml; run "N2 live feed with no version"
setup 9.9.1 signed.mar; mkdir -p $T/www/updates/$KEY/releases/9.9.1; cp $MARS/foreign.mar $T/www/updates/$KEY/releases/9.9.1/Ressac-9.9.1.mar; run "N3 9.9.1 already up with another MAR"
setup 9.9.1 signed.mar; mkdir -p $T/www/updates/$KEY/releases/9.9.1; cp $MARS/signed.mar $T/www/updates/$KEY/releases/9.9.1/Ressac-9.9.1.mar; run "N3 9.9.1 already up with the same MAR"
setup 9.9.1 signed.mar signed.mar 9.9.0; run "N4 update.xml for another version"
setup 9.9.1 signed.mar signed.mar 9.9.1 otherotherotherotherother000; run "N4 update.xml for another key"
setup 9.9.1 signed.mar unsigned.mar; run "N4 update.xml whose hash and size are another file's"
setup 9.9.1 signed.mar; print -r -- "export const notes = [{ version: \"9.9.0\" }];" > $T/app/shared/release-notes.ts; run "N4 release notes for another version"
setup 9.9.1 signed.mar; touch $T/www/FAIL; run "N6 host answers 500"; rm -f $T/www/FAIL
setup 9.9.1 signed.mar; out=$(RESSAC_PUBLISH_DRY_RUN=1 RESSAC_PUBLISH_SKIP_APPLE=1 RESSAC_PUBLISH_HOST=http://127.0.0.1:9 RESSAC_UPDATE_KEY=$KEY zsh $T/app/scripts/publish.sh 2>&1); print -r -- "N6 host unreachable -> rc=$?: $(print -r -- "$out" | grep '^publish:' | tail -1 | sed "s#$T#<scratch>#g")"
setup 9.9.1 signed.mar; out=$(RESSAC_PUBLISH_DRY_RUN=1 RESSAC_PUBLISH_SKIP_APPLE=1 RESSAC_PUBLISH_HOST=$HOST RESSAC_UPDATE_KEY=SHORT zsh $T/app/scripts/publish.sh 2>&1); print -r -- "N4 bad key shape -> rc=$?: $(print -r -- "$out" | tail -1)"
# N5: the test hooks exported WITHOUT dry-run. npx, git and curl are failing shims: nothing can be uploaded or fetched.
setup 9.9.1 signed.mar
out=$(PATH=$T/shims:$PATH RESSAC_PUBLISH_SKIP_APPLE=1 RESSAC_PUBLISH_HOST=$HOST RESSAC_UPDATE_KEY=$KEY zsh $T/app/scripts/publish.sh 2>&1); print -r -- "N5 hooks exported, no dry-run, dummy DMG -> rc=$?: $(print -r -- "$out" | grep -E '^publish:|SHIM' | tail -2 | tr '\n' ' ' | sed "s#$T#<scratch>#g")"
