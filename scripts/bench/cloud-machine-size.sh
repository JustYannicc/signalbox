#!/usr/bin/env bash
# Machine-size bench for cloud work machines (#386): how long and how much memory
# a cold install, the apps/server typecheck, the Runner tests and `vp run dev`
# take on the machine it runs on. Run it on a disposable Linux machine: every
# install run wipes node_modules and the pnpm store.
#
# Usage: scripts/bench/cloud-machine-size.sh [runs] [heap_mb]
#   BENCH_DIR   where to clone the repo (default: $TMPDIR/bench-repo); replaced each run
#   BENCH_LOGS  where step logs go (default: $TMPDIR)
#   STEPS       subset of: install typecheck typecheck-contracts test dev
#   REUSE=1     keep an installed BENCH_DIR instead of cloning again
# Clones from the current checkout when it is one, otherwise from GitHub.
# Prints one TSV row per step: step run rc wall_s cpu_s avg_cores base_mb peak_mb delta_mb oom note
set -u
[ -r /proc/stat ] || { echo "Needs a Linux machine (reads /proc and cgroups)." >&2; exit 1; }
RUNS=${1:-3}
HEAP=${2:-}
TMP=${TMPDIR:-/tmp}
TMP=${TMP%/}
CHECKOUT=$PWD
REPO=$(realpath -m "${BENCH_DIR:-$TMP/bench-repo}")
# The clone is deleted on every run, so it must be a directory of its own.
case "$CHECKOUT/" in "$REPO"/*) echo "Refusing BENCH_DIR=$REPO: it holds this checkout." >&2; exit 1;; esac
case "$REPO" in /|"$(realpath -m "$HOME")"|"$(realpath -m "$TMP")") echo "Refusing BENCH_DIR=$REPO" >&2; exit 1;; esac
mkdir -p "${BENCH_LOGS:-$TMP}"
LOGS=$(cd "${BENCH_LOGS:-$TMP}" && pwd)
case "$LOGS/" in "$REPO"/*) echo "Refusing BENCH_LOGS inside BENCH_DIR." >&2; exit 1;; esac
export LOGS

mem_used() { free -m | awk '/Mem:/{print $3}'; }
cpu_ticks() { awk '/^cpu /{print $2+$3+$4+$7+$8}' /proc/stat; }
oom_kills() { awk '/oom_kill /{print $2}' /sys/fs/cgroup/memory.events 2>/dev/null || echo na; }
HZ=$(getconf CLK_TCK)

echo "## machine"
echo "nproc=$(nproc) mem_total_mb=$(free -m | awk '/Mem:/{print $2}') swap_mb=$(free -m | awk '/Swap:/{print $2}') cgroup_mem_max=$(cat /sys/fs/cgroup/memory.max 2>/dev/null || echo na) cgroup_cpu_max=\"$(cat /sys/fs/cgroup/cpu.max 2>/dev/null || echo na)\""
echo "cpu_model=$(awk -F': ' '/model name/{print $2; exit}' /proc/cpuinfo)"
echo "disk_tmp=$(df -h "$TMP" | tail -1 | awk '{print $2" total, "$4" free"}') node=$(node -v) pnpm=$(corepack pnpm -v 2>/dev/null) vp_on_path=$(command -v vp || echo no)"
echo "checkout_cwd=$CHECKOUT has_package_json=$([ -f "$CHECKOUT/package.json" ] && echo yes || echo no) git_head=$(git -C "$CHECKOUT" rev-parse --short HEAD 2>/dev/null || echo none)"

STEPS=${STEPS:-install typecheck typecheck-contracts test dev}
echo "steps=$STEPS reuse=${REUSE:-0}"
t0=$(date +%s.%N)
if [ "${REUSE:-0}" = 1 ] && [ -x "$REPO/node_modules/.bin/vp" ]; then
  echo "clone_source=reused"
else
  rm -rf "$REPO"
  if [ -f "$CHECKOUT/package.json" ] && git -C "$CHECKOUT" rev-parse HEAD >/dev/null 2>&1; then
    git clone -q "$CHECKOUT" "$REPO"
    echo "clone_source=thread-checkout"
  else
    git clone -q --depth 1 https://github.com/JustYannicc/signalbox.git "$REPO"
    echo "clone_source=github"
  fi
fi
echo "clone_s=$(awk -v a="$t0" -v b="$(date +%s.%N)" 'BEGIN{printf "%.1f", b-a}') head=$(git -C "$REPO" rev-parse --short HEAD)"
cd "$REPO" || exit 1
export PATH="$REPO/node_modules/.bin:$PATH"
[ -n "$HEAP" ] && export NODE_OPTIONS="--max-old-space-size=$HEAP"
echo "NODE_OPTIONS=${NODE_OPTIONS:-<default>}"
echo
printf 'step\trun\trc\twall_s\tcpu_s\tavg_cores\tbase_mb\tpeak_mb\tdelta_mb\toom\tnote\n'

# step <name> <run> <command>; for dev, the command must print READY or FAIL and exit.
step() {
  local name=$1 run=$2 cmd=$3 log=$LOGS/bench-$1-$2.log
  local base peak=0 u c0 c1 t0 t1 k0 k1 rc oom note=""
  base=$(mem_used); k0=$(oom_kills); c0=$(cpu_ticks); t0=$(date +%s.%N)
  bash -c "$cmd" >"$log" 2>&1 &
  local pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    u=$(mem_used); [ "$u" -gt "$peak" ] && peak=$u
    sleep 0.5
  done
  wait "$pid"; rc=$?
  t1=$(date +%s.%N); c1=$(cpu_ticks); k1=$(oom_kills)
  u=$(mem_used); [ "$u" -gt "$peak" ] && peak=$u
  oom=no
  if grep -qE 'heap out of memory|Reached heap limit|ENOMEM|Killed' "$log" || [ "$rc" = 137 ] || [ "$k0" != "$k1" ]; then oom=yes; fi
  [ "$k0" != "$k1" ] && note="cgroup_oom_kills=$k0->$k1"
  sed -i 's/\x1b\[[0-9;]*m//g' "$log"
  [ "$name" = test ] && note="$note $(grep -E 'Test Files|Tests ' "$log" | tr -s ' \n\t' ' ')"
  [ "$name" = dev ] && note="$note $(grep -m1 -E '^(READY|FAIL)' "$log") $(grep -m3 -iE 'Local:|ready in|EADDR|error' "$log" | tr -s '\n\t' '  ' | cut -c1-300)"
  [ "$rc" != 0 ] && note="$note last: $(grep -v '^\s*$' "$log" | tail -c 400 | tr -s '\n\t' '  ')"
  awk -v n="$name" -v r="$run" -v rc="$rc" -v t0="$t0" -v t1="$t1" -v c0="$c0" -v c1="$c1" -v hz="$HZ" \
      -v b="$base" -v p="$peak" -v o="$oom" -v note="$note" \
    'BEGIN{w=t1-t0; c=(c1-c0)/hz; printf "%s\t%s\t%s\t%.1f\t%.1f\t%.2f\t%s\t%s\t%s\t%s\t%s\n", n,r,rc,w,c,(w>0?c/w:0),b,p,p-b,o,note}'
}

clean_install='rm -rf node_modules apps/*/node_modules packages/*/node_modules .vite-plus apps/*/.vite-plus packages/*/.vite-plus "$(corepack pnpm store path 2>/dev/null)" ~/.cache/pnpm ~/.local/share/pnpm/store; corepack pnpm install --frozen-lockfile'
typecheck='cd apps/server && tsc-rs --noEmit'
typecheck_contracts='cd packages/contracts && tsc-rs --noEmit'
tests='cd apps/server && vp test run src/signalbox/runner'
# Starts `vp run dev` on the clone's own .t3 (a plain clone gets no worktree default) in its own process group, waits for both its ports to answer HTTP, then kills that group (the PGID captured here, nothing else).
dev='rm -rf .t3; setsid vp run dev --home-dir "$PWD/.t3" >"$LOGS/bench-dev-raw.log" 2>&1 & pg=$!
for i in $(seq 1 600); do
  line=$(grep -m1 -o "serverPort=[0-9]* webPort=[0-9]*" "$LOGS/bench-dev-raw.log" 2>/dev/null)
  if [ -n "$line" ]; then sp=${line#serverPort=}; sp=${sp%% *}; wp=${line##*webPort=}
    w=$(node -e "fetch(process.argv[1]).then(r=>console.log(r.status),()=>console.log(0))" "http://localhost:$wp/")
    s=$(node -e "fetch(process.argv[1]).then(r=>console.log(r.status),()=>console.log(0))" "http://localhost:$sp/")
    if [ "$w" != 0 ] && [ "$s" != 0 ]; then echo "READY web=$wp($w) server=$sp($s) after_polls=$i"; kill -TERM -- -$pg; sleep 2; kill -KILL -- -$pg 2>/dev/null; exit 0; fi
  fi
  kill -0 $pg 2>/dev/null || { echo FAIL exited; tail -40 "$LOGS/bench-dev-raw.log"; exit 1; }
  sleep 0.5
done
echo FAIL timeout; tail -40 "$LOGS/bench-dev-raw.log"; kill -KILL -- -$pg; exit 1'

# With a heap given, first see whether install fits at Node's default heap.
if [ -n "$HEAP" ] && [[ " $STEPS " == *" install "* ]]; then
  NODE_OPTIONS= step install-default-heap 0 "unset NODE_OPTIONS; $clean_install"
fi
for run in $(seq 1 "$RUNS"); do
  [[ " $STEPS " == *" install "* ]] && step install "$run" "$clean_install"
  [ -x node_modules/.bin/vp ] || { echo "install failed, stopping"; break; }
  [[ " $STEPS " == *" typecheck "* ]] && step typecheck "$run" "$typecheck"
  [[ " $STEPS " == *" typecheck-contracts "* ]] && step typecheck-contracts "$run" "$typecheck_contracts"
  [[ " $STEPS " == *" test "* ]] && step test "$run" "$tests"
  [[ " $STEPS " == *" dev "* ]] && step dev "$run" "$dev"
done
echo
echo "node_modules_size=$(du -sh node_modules 2>/dev/null | cut -f1) disk_tmp_after=$(df -h "$TMP" | tail -1 | awk '{print $4" free"}')"
echo "BENCH DONE"
