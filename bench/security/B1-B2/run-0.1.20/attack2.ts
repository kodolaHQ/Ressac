// Focused re-test: the one real candidate (B16 userns) + a correct check of Mac-home absence (C2.1/C2.2) and SSH keys.
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createMachine, vmImage } from "../../../../apps/firefox/host/machine.ts";
import { DEFAULT_DOCKER_FOLDER, Workshop, spacePaths } from "../../../../packages/kernel/src/index.ts";

const env = (k: string) => process.env[k] ?? (() => { throw new Error(`${k} missing`); })();
const home = env("LIMA_HOME");
const root = env("RESSAC_ROOT");
const engineDir = join(DEFAULT_DOCKER_FOLDER, "engine");
const tools = { limactl: env("RESSAC_LIMACTL"), podman: env("RESSAC_PODMAN"), template: env("RESSAC_VM_TEMPLATE") };
const machine = createMachine({ ...tools, home, engine: engineDir, ressacRoot: root, busy: async () => false, image: vmImage() });
const network = { ports: [] as number[], domains: [] as string[] };
const workshop = new Workshop({ paths: spacePaths(root), engine: () => machine, network: () => network });
const vm = (cmd: string) => spawnSync(tools.limactl, ["shell", "--workdir", "/", "ressac", "sh", "-c", cmd], { encoding: "utf8", env: process.env, timeout: 120_000 });
const x = (cmd: string) => workshop.exec(["sh", "-c", cmd]);
const show = (id: string, r: { stdout: string; stderr: string }) => console.log(`\n----- ${id} -----\n${r.stdout}\n[stderr] ${r.stderr}`.slice(0, 1400));

async function main() {
  mkdirSync(join(root, "tmp"), { recursive: true });
  await machine.install();
  await workshop.ensureStarted();
  const MACHOME = process.env.HOME!;

  // ---- C2.1/C2.2: the MAC home content must be absent in the container and the guest ----
  show("C2.1-container", await x(`for p in ${MACHOME}/.ssh ${MACHOME}/Library ${MACHOME}/.aws ${MACHOME}/.zshrc ${MACHOME}/.config ${MACHOME}/Documents/projet-perso/Ressac; do [ -e "$p" ] && echo "PRESENT:$p" || echo "absent:$p"; done; echo "---ls $HOME:"; ls -a ${MACHOME} 2>&1`));
  show("C2.1-guest", vm(`for p in ${MACHOME}/.ssh ${MACHOME}/Library ${MACHOME}/.aws ${MACHOME}/.zshrc ${MACHOME}/.config; do [ -e "$p" ] && echo "PRESENT:$p" || echo "absent:$p"; done; echo "---ls -a ${MACHOME}:"; ls -a ${MACHOME} 2>&1`));

  // ---- SSH: the only .ssh in the guest is Lima's own control key, not the Mac's keys; no agent ----
  show("B25-ssh-guest", vm(`echo "SSH_AUTH_SOCK=$SSH_AUTH_SOCK"; echo "--- guest user ssh dir:"; ls -la $HOME/.ssh 2>&1; echo "--- keys content names:"; cat $HOME/.ssh/authorized_keys 2>&1 | sed 's/ [A-Za-z0-9+/=]\\{20\\}.*/ <KEY-BODY>/' | head; echo "--- any Mac private keys leaked?"; grep -rl 'PRIVATE KEY' $HOME/.ssh 2>&1 | head`));

  // ---- B16: userns escalation — does the all-caps nested userns enable any real escape? ----
  const uns = await x(`unshare -Urm sh -c '
    echo "id:"; id;
    grep CapEff /proc/self/status;
    echo "--- remount .ressac rw:"; mount -o remount,rw /workspace/.ressac 2>&1; echo remount=$?;
    echo "--- write .ressac after remount:"; echo HACK > /workspace/.ressac/pwned 2>&1; echo write=$?; ls /workspace/.ressac/pwned 2>&1;
    echo "--- bind-mount over .ressac:"; mkdir -p /tmp/ov && echo attacker > /tmp/ov/launch-profiles.json; mount --bind /tmp/ov /workspace/.ressac 2>&1; echo bind=$?; cat /workspace/.ressac/launch-profiles.json 2>&1 | head -1;
    echo "--- can we reach iptables now?"; iptables -L >/dev/null 2>&1; echo iptables=$?;
    echo "--- mknod a block device (host disk access)?"; mknod /tmp/sda b 8 0 2>&1; echo mknod=$?;
    echo "--- read host via /proc/1/root?"; ls /proc/1/root/ 2>&1 | head -1;
  ' 2>&1; echo outer_code=$?`);
  show("B16-userns-escape", uns);
  // After unshare exits, is .ressac still read-only from the normal mount ns?
  show("B16-after", await x(`echo persist > /workspace/.ressac/pwned2 2>&1; echo write=$?; ls /workspace/.ressac/pwned 2>&1`));

  await machine.stop().catch(() => {});
  console.log("\n=== attack2 done ===");
}
main().then(() => process.exit(0)).catch((e) => { console.error("ERR", e); process.exit(1); });
