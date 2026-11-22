# Source in a shell next to a running drv.mts: BENCH_TMP is the driver's temp folder, RESSAC_PODMAN the pinned podman.
T=${BENCH_TMP:?set BENCH_TMP to the driver temp folder}
PODMAN=${RESSAC_PODMAN:?set RESSAC_PODMAN to the pinned podman binary}
PARGS=($(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).podmanArgs.join(" "))' "$T/state.json"))
C=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).container)' "$T/state.json")
CTL=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).control)' "$T/state.json")
ctl() { curl -s --max-time ${2:-120} --data-binary "$1" http://127.0.0.1:$CTL; echo; }
xn() { "$PODMAN" "${PARGS[@]}" exec "$C" sh -c "$1"; }
xroot() { "$PODMAN" "${PARGS[@]}" exec -u root "$C" sh -c "$1"; }
