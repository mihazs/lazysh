#!/bin/sh
# The Waydroid acceptance lane (#2093): start or attach to a headless Waydroid session, install APKs, run named instrumentation classes
# and benchmark commands, tear down, and write one evidence JSON in the baseline format (docs/architecture/terminal-benchmarks.md, schema 1)
# with the environment of the guest and what Waydroid cannot establish. It never skips: a missing tool, container, compositor or guest is an
# error with its own exit code, and an instrumentation class that runs no test or skips one fails the lane. Runbook: docs/architecture/waydroid-lane.md.
#
# Usage: waydroid-lane.sh --out <evidence.json> [--label <text>] [--package <id>]
#          [--owned-ssh-fixture] [--build <build.sh>]... [--uninstall <package>]... [--apk <file>]... [--instrument <runner> <class>]... [--bench <name> <command>]...
# --uninstall <package> removes a package (and its data) from the guest before the installs that follow it: a debug APK of another CI run has another signature and does not update in place.
# Every instrumentation step is also given -e lazyshRunId <the run id>, which the evidence a class writes carries.
# --owned-ssh-fixture starts the owned OpenSSH server of tests/support/sshFixture.ts on this host (loopback), reaches it from the guest with
# "adb reverse", pushes its fixture to /data/local/tmp/lazysh-ui-ssh-<nonce>/ and passes -e lazyshSshFixture to every instrumentation step.
# Exit: 0 passed, 1 a step failed (evidence written with status "failed"), 2 usage, 3 missing tool, 4 container not active,
#       5 no Wayland compositor, 6 lock timeout, 7 session or guest did not come up (no evidence written for 3 to 7).
# Environment: LAZYSH_WAYDROID_SERIAL (default $ANDROID_SERIAL or 192.168.240.112:5555), ADB (adb binary), ANDROID_HOME and JAVA_HOME and
# LAZYSH_WAYDROID_BUILD_ASSETS (for --build, see android-apk.sh), LAZYSH_WAYDROID_LOCK (default /tmp/lazysh-waydroid-lane.lock; the lane is a
# shared resource), LAZYSH_WAYDROID_LOCK_HELD=1 (the caller holds it), LAZYSH_WAYDROID_FIXTURE_CMD (sh command that runs the fixture helper, default bun on
# tests/support/waydroidSshFixture.ts; it gets the work directory as $1), LAZYSH_WAYDROID_{LOCK_WAIT_S,LOCK_POLL_S,LOCK_STALE_MIN,BOOT_WAIT_S,POLL_S}.
set -u

here=$(cd "$(dirname "$0")" && pwd)
adb=${ADB:-adb}
serial=${LAZYSH_WAYDROID_SERIAL:-${ANDROID_SERIAL:-192.168.240.112:5555}}
lock=${LAZYSH_WAYDROID_LOCK:-/tmp/lazysh-waydroid-lane.lock}
lock_wait=${LAZYSH_WAYDROID_LOCK_WAIT_S:-3600}
lock_poll=${LAZYSH_WAYDROID_LOCK_POLL_S:-60}
lock_stale=${LAZYSH_WAYDROID_LOCK_STALE_MIN:-90}
boot_wait=${LAZYSH_WAYDROID_BOOT_WAIT_S:-180}
poll=${LAZYSH_WAYDROID_POLL_S:-2}
out='' label='' package=app.lazysh.client
work='' lock_held='' session_pid='' connected='' guest_up='' owned_ssh='' fixture_pid='' fixture_port='' fixture_remote=''
failures=''

say() { echo "waydroid-lane: $*" >&2; }
die() { code=$1; shift; say "$*"; exit "$code"; }
adb_s() { "$adb" -s "$serial" "$@" </dev/null; }
now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
# retry <seconds> <command...>: run until it succeeds or the time is up.
retry() {
  limit=$(($(date +%s) + $1)); shift
  until "$@"; do
    [ "$(date +%s)" -lt "$limit" ] || return 1
    sleep "$poll"
  done
}

# Waydroid freezes its container while no app is shown, and adb then hangs until an app is launched.
thaw() { waydroid app launch "$package" >/dev/null 2>&1; }
cleanup() {
  if [ -n "$guest_up" ]; then thaw; fi
  if [ -n "$fixture_pid" ]; then
    kill "$fixture_pid" 2>/dev/null  # the helper stops its sshd on SIGTERM
    retry 20 fixture_gone || kill -9 "$fixture_pid" 2>/dev/null
    wait "$fixture_pid" 2>/dev/null
  fi
  if [ -n "$fixture_port" ]; then adb_s reverse --remove "tcp:$fixture_port" >/dev/null 2>&1; fi
  if [ -n "$fixture_remote" ]; then adb_s shell rm -rf "$fixture_remote" >/dev/null 2>&1; fi
  if [ -n "$guest_up" ]; then adb_s shell am force-stop "$package" >/dev/null 2>&1; fi
  if [ -n "$connected" ]; then "$adb" disconnect "$serial" >/dev/null 2>&1; fi
  # Only a session this run started is stopped; an attached one is left as it was found.
  if [ -n "$session_pid" ]; then
    waydroid session stop >/dev/null 2>&1
    retry 30 session_gone || kill "$session_pid" 2>/dev/null
  fi
  if [ -n "$lock_held" ]; then rmdir "$lock" 2>/dev/null; fi
  if [ -n "$work" ]; then rm -rf "$work"; fi
}
# The wrapper records the exit status of "waydroid session start", which blocks for as long as the session lives (kill -0 would also see an unreaped child).
session_gone() { [ -f "$work/session.exit" ]; }
# Linux only (as Waydroid is): an unreaped child still answers kill -0, so a zombie counts as gone.
fixture_gone() { [ ! -d "/proc/$fixture_pid" ] || grep -q '^[0-9]* (.*) Z' "/proc/$fixture_pid/stat"; }
trap cleanup EXIT
trap 'exit 130' INT TERM HUP

# --- arguments: the plan is a file of tab-separated steps, run in the order given -----------------------------------------------------
work=$(mktemp -d) || die 2 'cannot create a work directory'
plan="$work/plan"; : > "$plan"; : > "$work/results.jsonl"
usage() { die 2 "$*; usage: waydroid-lane.sh --out <evidence.json> [--label <text>] [--package <id>] [--owned-ssh-fixture] [--build <build.sh>]... [--uninstall <package>]... [--apk <file>]... [--instrument <runner> <class>]... [--bench <name> <command>]..."; }
step() { printf '%s\t%s\t%s\n' "$1" "$2" "${3:-}" >> "$plan"; }
while [ $# -gt 0 ]; do
  flag=$1
  case $flag in
    --out | --label | --package | --build | --apk | --uninstall) [ $# -ge 2 ] || usage "$flag needs a value"; value=$2; shift 2 ;;
    --owned-ssh-fixture) owned_ssh=1; shift; continue ;;
    --instrument | --bench) [ $# -ge 3 ] || usage "$flag needs two values"; value=$2; second=$3; shift 3 ;;
    *) usage "unknown argument $1" ;;
  esac
  case $flag in
    --out) out=$value ;;
    --label) label=$value ;;
    --package) package=$value ;;
    --build) step build "$value" ;;
    --apk) step install "$value" ;;
    --uninstall)
      case $value in '' | *[!A-Za-z0-9_.]*) usage "bad package: $value" ;; esac
      step uninstall "$value" ;;
    --instrument)
      # Both values are quoted into a remote shell command line: only class and runner characters.
      case $value$second in *[!A-Za-z0-9_.\$#,/]*) usage "bad runner or class: $value $second" ;; esac
      step instrument "$value" "$second" ;;
    --bench)
      case $value in '' | *[!A-Za-z0-9._-]*) usage "bad benchmark name: $value" ;; esac
      step bench "$value" "$second" ;;
  esac
done
[ -n "$out" ] || usage '--out is required'
[ -s "$plan" ] || usage 'nothing to run: give at least one --apk, --build, --instrument or --bench'
case $package in '' | *[!A-Za-z0-9_.]*) usage "bad package: $package" ;; esac
mkdir -p "$(dirname "$out")" || die 2 "cannot create the directory of $out"

# --- refuse to run without what the lane needs ------------------------------------------------------------------------------------------
command -v waydroid >/dev/null 2>&1 || die 3 'waydroid is not installed (no waydroid on PATH); install it from https://docs.waydro.id and run "waydroid init"'
command -v "$adb" >/dev/null 2>&1 || die 3 "adb is not installed ($adb not found); install the Android platform-tools or set ADB"
command -v jq >/dev/null 2>&1 || die 3 'jq is not installed; the evidence file is written with it'
container_active() {
  case $(waydroid status 2>/dev/null | sed -n 's/^Container:[[:space:]]*//p') in RUNNING | FROZEN) return 0 ;; esac
  command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet "${LAZYSH_WAYDROID_UNIT:-waydroid-container}"
}
container_active || die 4 'the Waydroid container is not active (systemctl is-active waydroid-container); starting it needs root: sudo systemctl start waydroid-container'
session_state() { waydroid status 2>/dev/null | sed -n 's/^Session:[[:space:]]*//p'; }
# A running session needs no compositor from this run; starting one does.
if [ "$(session_state)" != RUNNING ]; then
  [ -n "${WAYLAND_DISPLAY:-}" ] && [ -S "${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/$WAYLAND_DISPLAY" ] ||
    die 5 "no Wayland compositor: WAYLAND_DISPLAY=${WAYLAND_DISPLAY:-unset} has no socket in ${XDG_RUNTIME_DIR:-/run/user/$(id -u)}; Waydroid needs a desktop session (or a headless compositor such as weston --backend=headless) to start"
fi

# --- the shared lane lock (mkdir is atomic; a lock older than lock_stale minutes belongs to a dead run) -------------------------------------
if [ -z "${LAZYSH_WAYDROID_LOCK_HELD:-}" ]; then
  limit=$(($(date +%s) + lock_wait))
  until mkdir "$lock" 2>/dev/null; do
    if [ -n "$(find "$lock" -maxdepth 0 -mmin "+$lock_stale" 2>/dev/null)" ] && rmdir "$lock" 2>/dev/null; then say "removed a stale lock: $lock"; continue; fi
    [ "$(date +%s)" -lt "$limit" ] || die 6 "the Waydroid lane lock $lock is held by another run; waited ${lock_wait}s"
    sleep "$lock_poll"
  done
  lock_held=1
fi

# --- the session: attach to a running one, else start one without showing its UI --------------------------------------------------------------
started_by_lane=false
if [ "$(session_state)" != RUNNING ]; then
  say 'starting a headless Waydroid session'
  ( waydroid session start >"$work/session.log" 2>&1; echo $? >"$work/session.exit" ) &
  session_pid=$!; started_by_lane=true
  session_running() { [ "$(session_state)" = RUNNING ] || { session_gone && die 7 "waydroid session start failed: $(tail -n 5 "$work/session.log" | tr '\n' ' ') (a failing waydroid-net.sh start needs root)"; false; }; }
  retry "$boot_wait" session_running || die 7 "the Waydroid session did not reach RUNNING within ${boot_wait}s: $(tail -n 5 "$work/session.log" | tr '\n' ' ')"
else
  say 'attaching to the running Waydroid session'
fi
# A connection somebody else made is theirs: only one this run opened is closed again.
case $serial in *:*) "$adb" devices 2>/dev/null | grep -q "^$serial[[:space:]]" || connected=1 ;; esac
guest_ready() {
  case $serial in *:*) "$adb" connect "$serial" >/dev/null 2>&1 ;; esac
  [ "$(adb_s shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = 1 ]
}
thaw
retry "$boot_wait" guest_ready || die 7 "the guest $serial did not finish booting within ${boot_wait}s (adb devices; waydroid status)"
guest_up=1

# --- the environment block --------------------------------------------------------------------------------------------------------------------
prop() { adb_s shell getprop "$1" 2>/dev/null | tr -d '\r'; }
gles=$(adb_s shell 'dumpsys SurfaceFlinger | grep -m1 GLES' 2>/dev/null | tr -d '\r' | sed 's/^[[:space:]]*GLES:[[:space:]]*//')
egl=$(prop ro.hardware.egl); gralloc=$(prop ro.hardware.gralloc)
# A software rasterizer named by the GLES string or the guest's EGL is the software path; anything else the host's GL; unreadable stays unknown.
case $(printf '%s %s' "$gles" "$egl" | tr '[:upper:]' '[:lower:]') in
  *swiftshader* | *llvmpipe* | *softpipe* | *software*) gpu_path=software ;;
  ' ') gpu_path=unknown ;;
  *) gpu_path=host-gl ;;
esac
package_dump=$(adb_s shell dumpsys package "$package" 2>/dev/null | tr -d '\r')
package_field() { printf '%s\n' "$package_dump" | sed -n "s/^[[:space:]]*$1=\\([^ ]*\\).*/\\1/p" | head -n 1; }
packages=$(adb_s shell pm list packages 2>/dev/null | tr -d '\r')
vendor_imes=$(printf '%s\n' "$packages" | sed -n 's/^package://p' | grep -E '^(com\.google\.android\.inputmethod\.latin|com\.touchtype\.swiftkey)$' | jq -R . | jq -sc .)
source_commit=$(git -C "$here" rev-parse HEAD 2>/dev/null)
source_dirty=null  # unknown without a git checkout
if [ -n "$source_commit" ]; then if [ -z "$(git -C "$here" status --porcelain 2>/dev/null)" ]; then source_dirty=false; else source_dirty=true; fi; fi
environment=$(jq -n \
  --arg serial "$serial" --arg model "$(prop ro.product.model)" --arg abi "$(prop ro.product.cpu.abi)" \
  --arg wmSize "$(adb_s shell wm size 2>/dev/null | tr -d '\r')" --arg wmDensity "$(adb_s shell wm density 2>/dev/null | tr -d '\r')" \
  --arg fingerprint "$(prop ro.build.fingerprint)" --arg display "$(prop ro.build.display.id)" --arg flavor "$(prop ro.build.flavor)" \
  --arg lineage "$(prop ro.lineage.version)" --arg waydroid "$(waydroid --version 2>/dev/null | head -n 1)" --argjson started "$started_by_lane" \
  --arg release "$(prop ro.build.version.release)" --arg sdk "$(prop ro.build.version.sdk)" \
  --arg path "$gpu_path" --arg egl "$egl" --arg gralloc "$gralloc" --arg gles "$gles" \
  --arg commit "$source_commit" --argjson dirty "$source_dirty" --arg package "$package" \
  --arg versionName "$(package_field versionName)" --arg versionCode "$(package_field versionCode)" \
  --arg ime "$(adb_s shell settings get secure default_input_method 2>/dev/null | tr -d '\r')" --arg imes "$(adb_s shell ime list -s 2>/dev/null | tr -d '\r')" \
  --argjson vendorImes "$vendor_imes" '
  def blank: if . == "" or . == "null" then null else . end;
  { device: { serial: $serial, model: ($model | blank), abi: ($abi | blank), wmSize: ($wmSize | blank), wmDensity: ($wmDensity | blank) },
    waydroidImage: { waydroid: ($waydroid | blank), fingerprint: ($fingerprint | blank), display: ($display | blank), flavor: ($flavor | blank),
                     lineageVersion: ($lineage | blank), sessionStartedByLane: $started },
    androidVersion: { release: ($release | blank), sdk: ($sdk | blank) },
    gpuPath: { path: $path, egl: ($egl | blank), gralloc: ($gralloc | blank), glesRenderer: ($gles | blank) },
    appRevision: { commit: ($commit | blank), dirty: $dirty, package: $package, versionName: ($versionName | blank), versionCode: ($versionCode | blank) },
    guestIme: { default: ($ime | blank), enabled: ($imes | split("\n") | map(select(. != ""))) },
    vendorImesInstalled: $vendorImes }')
started_at=$(now)
# One id names the run: the evidence records it and every --bench command gets it as LAZYSH_LANE_RUN_ID, so records written by separate
# commands of one run (the benchmark arms of one engine comparison) can be told to belong together.
run_id=$(printf '%s-%s' "${label:-lane}" "$(printf '%s' "$started_at" | tr -dc '0-9TZ')" | tr -c 'A-Za-z0-9._\n-' '-')

# --- the steps ----------------------------------------------------------------------------------------------------------------------------------
fail() { message=$(printf '%s' "$1" | tr '\n' ' '); failures="$failures$message
"; say "FAILED: $message"; }
record() { jq -nc "$@" >> "$work/results.jsonl"; }
sha() { sha256sum "$1" | cut -d' ' -f1; }
install_apk() { # install_apk <apk>: returns non-zero on a failed install
  [ -f "$1" ] || { fail "install: $1 does not exist"; return 1; }
  say "installing $1"
  output=$(adb_s install -r -t "$1" 2>&1); code=$?
  ok=false; [ "$code" -eq 0 ] && case $output in *Success*) ok=true ;; esac
  record --arg apk "$1" --arg sha256 "$(sha "$1")" --arg output "$output" --argjson ok "$ok" '{kind: "install", apk: $apk, sha256: $sha256, ok: $ok, output: $output}'
  [ "$ok" = true ] || { fail "install: $1 was not installed: $output"; return 1; }
}
run_uninstall() { # run_uninstall <package>: a package that is not installed is not an error
  say "uninstalling $1"
  output=$(adb_s uninstall "$1" 2>&1); ok=false
  case $output in *Success* | *'Unknown package'* | *'not installed'*) ok=true ;; esac
  record --arg package "$1" --arg output "$output" --argjson ok "$ok" '{kind: "uninstall", package: $package, ok: $ok, output: $output}'
  [ "$ok" = true ] || { fail "uninstall: $1 was not removed: $output"; return 1; }
}
run_build() { # run_build <build.sh>: builds with the existing android-apk.sh entry points, then installs
  [ -n "${ANDROID_HOME:-}" ] && [ -n "${JAVA_HOME:-}" ] || { fail "build: $1 needs ANDROID_HOME (the SDK) and JAVA_HOME"; return 1; }
  apk="$work/build-$(basename "$(dirname "$1")").apk"
  say "building $1"
  sh "$1" "$ANDROID_HOME" "$JAVA_HOME" "$apk" ${LAZYSH_WAYDROID_BUILD_ASSETS:+"$LAZYSH_WAYDROID_BUILD_ASSETS"} >&2 || { fail "build: $1 failed"; return 1; }
  install_apk "$apk"
}
run_instrument() { # run_instrument <runner> <class>: counts the raw status codes of am instrument; zero tests or a skipped one fail
  say "instrumenting $2 with $1"
  thaw
  # The evidence a class leaves on the guest (app.lazysh.client.Evidence: JSON and pictures) is kept beside the lane's own: start from none.
  adb_s shell rm -rf /data/local/tmp/lazysh-evidence >/dev/null 2>&1
  extra=" -e lazyshRunId '$run_id'"; [ -z "$fixture_remote" ] || extra="$extra -e lazyshSshFixture '$fixture_remote/fixture.json'"
  # Match Gradle so the runner can report before Tao exits the last Activity.
  runner_args=''
  case "$1" in */androidx.test.runner.AndroidJUnitRunner) runner_args=' -e waitForActivitiesToComplete false' ;; esac
  raw=$(adb_s shell "am instrument -w -r$runner_args -e class '$2'$extra '$1'" 2>&1 | tr -d '\r')
  count() { printf '%s\n' "$raw" | grep -c "^INSTRUMENTATION_STATUS_CODE: $1\$"; }
  passed=$(count 0); failed=$(($(count -1) + $(count -2))); skipped=$(($(count -3) + $(count -4)))
  reason=''
  # The -r status blocks of a failed or erring test carry its class, test and stack: keep them as evidence.
  details=$(printf '%s\n' "$raw" | awk '
    /^INSTRUMENTATION_STATUS: / { line = substr($0, 25); key = line; sub(/=.*/, "", key); val = line; sub(/^[^=]*=/, "", val)
      instack = 0
      if (key == "class") cls = val; else if (key == "test") test = val; else if (key == "stack") { stack = val; instack = 1 }
      next }
    /^INSTRUMENTATION_STATUS_CODE: / { if ($2 == "-1" || $2 == "-2") printf "%s\t%s\t%s\n", cls, test, stack; stack = ""; instack = 0; next }
    /^INSTRUMENTATION_/ { instack = 0; next }
    instack { stack = stack "\001" $0 }' | jq -Rsc 'split("\n") | map(select(. != "") | split("\t") | {class: .[0], test: .[1], message: ((.[2:] | join("\t")) | split("\u0001")[0]), stack: ((.[2:] | join("\t")) | gsub("\u0001"; "\n"))})')
  [ -n "$details" ] || details='[]'
  case $raw in *'INSTRUMENTATION_CODE: -1'*) ;; *) reason='the instrumentation did not finish (crashed, or the runner or class is not installed)' ;; esac
  [ "$failed" -eq 0 ] || reason="$failed test(s) failed: $(printf '%s' "$details" | jq -r 'map(.test + ": " + .message) | join("; ")')"
  [ "$skipped" -eq 0 ] || reason="$skipped test(s) skipped: the lane does not skip"
  [ "$passed" -gt 0 ] || [ -n "$reason" ] || reason='no test ran for this class'
  ok=true; [ -z "$reason" ] || { ok=false; fail "instrument $2: $reason"; }
  kept='[]'; stem=$(basename "$out" .json); short=${2##*.}; pulled="$work/evidence-$short"; mkdir -p "$pulled"
  if adb_s pull /data/local/tmp/lazysh-evidence/. "$pulled" >/dev/null 2>&1; then
    for file in "$pulled"/*; do
      [ -f "$file" ] || continue
      name="$stem-$short-$(basename "$file")"; cp "$file" "$(dirname "$out")/$name"
      kept=$(printf '%s' "$kept" | jq -c --arg path "$name" --arg sha256 "$(sha "$file")" '. + [{path: $path, sha256: $sha256}]')
    done
  fi
  record --argjson files "$kept" --arg runner "$1" --arg class "$2" --argjson passed "$passed" --argjson failed "$failed" --argjson skipped "$skipped" --arg reason "$reason" --argjson ok "$ok" --argjson details "$details" \
    '{kind: "instrumentation", runner: $runner, class: $class, passed: $passed, failed: $failed, skipped: $skipped, ok: $ok, reason: ($reason | if . == "" then null else . end)}
     + (if ($details | length) > 0 then {failedTests: $details} else {} end) + (if ($files | length) > 0 then {files: $files} else {} end)'
}
run_bench() { # run_bench <name> <command>: the command writes its result files into $LAZYSH_LANE_OUT; they are kept beside the evidence
  say "benchmark $1: $2"
  mkdir "$work/bench-$1" || { fail "bench $1: the name is used twice"; return 1; }
  fixture_path=''; [ -z "$fixture_remote" ] || fixture_path="$fixture_remote/fixture.json"
  LAZYSH_LANE_SSH_FIXTURE=$fixture_path LAZYSH_BENCH_ANDROID=$serial LAZYSH_LANE_OUT="$work/bench-$1" LAZYSH_LANE_PACKAGE=$package LAZYSH_LANE_RUN_ID=$run_id sh -c "$2" >&2 </dev/null; code=$?
  files='[]'; stem=$(basename "$out" .json)
  for file in "$work/bench-$1"/*; do
    [ -f "$file" ] || continue
    kept="$stem-$1-$(basename "$file")"; cp "$file" "$(dirname "$out")/$kept"
    files=$(printf '%s' "$files" | jq -c --arg path "$kept" --arg sha256 "$(sha "$file")" '. + [{path: $path, sha256: $sha256}]')
  done
  # A run that exits 0 and leaves nothing (a Playwright spec that skipped itself, say) measured nothing: the lane does not skip.
  ok=false
  if [ "$code" -ne 0 ]; then fail "bench $1 exited $code"
  elif [ "$files" = '[]' ]; then fail "bench $1 wrote no result file into \$LAZYSH_LANE_OUT, so nothing was measured"
  else ok=true; fi
  record --arg name "$1" --arg command "$2" --argjson exitCode "$code" --argjson files "$files" --argjson ok "$ok" '{kind: "benchmark", name: $name, command: $command, exitCode: $exitCode, ok: $ok, files: $files}'
}

start_fixture() { # the owned OpenSSH of tests/support/sshFixture.ts on this host, reached from the guest over adb reverse
  say 'starting the owned SSH fixture'
  mkdir "$work/fixture" || return 1
  FIXTURE_TS="$here/../../../tests/support/waydroidSshFixture.ts" sh -c "${LAZYSH_WAYDROID_FIXTURE_CMD:-exec bun \"\$FIXTURE_TS\" \"\$1\"}" fixture "$work/fixture" \
    >"$work/fixture/ready" 2>"$work/fixture/log" </dev/null &
  fixture_pid=$!
  ready_or_dead() { [ -s "$work/fixture/ready" ] || fixture_gone; }
  retry 60 ready_or_dead
  [ -s "$work/fixture/ready" ] || { fail "owned SSH fixture did not start: $(tail -n 5 "$work/fixture/log")"; return 1; }
  port=$(jq -r '.port' "$work/fixture/ready"); nonce=$(jq -r '.nonce' "$work/fixture/ready"); file=$(jq -r '.file' "$work/fixture/ready")
  case $port in '' | *[!0-9]*) fail "owned SSH fixture reported a bad port: $port"; return 1 ;; esac
  case $nonce in *[!a-f0-9]* | '') fail "owned SSH fixture reported a bad nonce"; return 1 ;; esac
  [ "${#nonce}" -eq 32 ] || { fail 'owned SSH fixture reported a bad nonce'; return 1; }
  remote=/data/local/tmp/lazysh-ui-ssh-$nonce
  thaw
  # --no-rebind: a guest port somebody else already forwards is an error, never silently taken over.
  adb_s reverse --no-rebind "tcp:$port" "tcp:$port" >/dev/null && fixture_port=$port || { fail "adb reverse tcp:$port failed"; return 1; }
  fixture_remote=$remote
  adb_s shell mkdir -m 700 "$remote" && adb_s push "$file" "$remote/fixture.json" >/dev/null && adb_s shell chmod 600 "$remote/fixture.json" ||
    { fail "pushing the owned SSH fixture to $remote failed"; return 1; }
}

tab=$(printf '\t')
setup_ok=true
[ -z "$owned_ssh" ] || start_fixture || setup_ok=false
while IFS=$tab read -r kind a b <&3; do
  [ "$setup_ok" = true ] || break
  case $kind in
    build) run_build "$a" || setup_ok=false ;;
    uninstall) run_uninstall "$a" || setup_ok=false ;;
    install) install_apk "$a" || setup_ok=false ;;
    instrument) run_instrument "$a" "$b" ;;
    bench) run_bench "$a" "$b" ;;
  esac
done 3< "$plan"
[ "$setup_ok" = true ] || fail 'the steps after the failed setup step did not run'

# --- the evidence ---------------------------------------------------------------------------------------------------------------------------------
status=passed; [ -z "$failures" ] || status=failed
evidence="$out.tmp.$$"
jq -n --arg label "$label" --arg runId "$run_id" --arg status "$status" --arg failures "$failures" --arg startedAt "$started_at" --arg finishedAt "$(now)" \
  --arg cpu "$(sed -n 's/^model name[[:space:]]*:[[:space:]]*//p' /proc/cpuinfo 2>/dev/null | head -n 1)" --arg cpus "$(nproc 2>/dev/null)" \
  --arg os "$(uname -sr)" --arg load "$(cut -d' ' -f1-3 /proc/loadavg 2>/dev/null)" --arg waydroid "$(waydroid --version 2>/dev/null | head -n 1)" \
  --arg adbVersion "$("$adb" version 2>/dev/null | head -n 1)" --arg commit "$source_commit" --argjson dirty "$source_dirty" \
  --slurpfile results "$work/results.jsonl" --argjson environment "$environment" '
  def blank: if . == "" then null else . end;
  { schema: 1, run: "waydroid lane", runId: $runId, label: ($label | blank), status: $status, failures: ($failures | split("\n") | map(select(. != ""))),
    startedAt: $startedAt, finishedAt: $finishedAt,
    host: { cpu: ($cpu | blank), logicalCpus: ($cpus | tonumber? // null), os: $os, loadAverageAtEnd: ($load | split(" ") | map(tonumber? // empty)) },
    toolchain: { waydroid: ($waydroid | blank), adb: ($adbVersion | blank) },
    source: { commit: ($commit | blank), dirty: $dirty },
    environment: $environment,
    limits: "Waydroid is the Android acceptance environment for the native-engine release (ADR 0001, Amendment 6). Its guest is x86_64 on the host GPU or a software rasterizer, so these timings are not a device result and every acceptedRisk below is not measured.",
    acceptedRisk: [
      { id: "energy", gate: "G16", status: "accepted risk, not measured", reason: "Waydroid has no phone battery to read, so battery energy cannot be compared between engines." },
      { id: "vendor-ime", gate: "G6", status: "accepted risk, not measured", reason: "Gboard and SwiftKey are not part of the guest unless installed and run; see vendorImesInstalled in the environment block and the guest IME." },
      { id: "real-gpu-drivers", gate: "G13", status: "accepted risk, not measured", reason: "The guest draws through the host GPU path or a software rasterizer, not a phone GPU driver." },
      { id: "touch", gate: "G13", status: "accepted risk, not measured", reason: "Touches are injected events; a real digitizer, palm rejection and pressure are not exercised." },
      { id: "thermal", gate: "G14", status: "accepted risk, not measured", reason: "A workstation host does not throttle like a phone; sustained-load behaviour is unknown." },
      { id: "aarch64", gate: "G12", status: "accepted risk, not measured", reason: "The guest is x86_64; the arm64 build that ships has not run here." },
      { id: "vendor-webview-rom", gate: "G14", status: "accepted risk, not measured", reason: "One WebView and one LineageOS-based image; vendor WebView and ROM variation are not covered." }
    ],
    results: $results }' > "$evidence" || { rm -f "$evidence"; die 1 'could not write the evidence file'; }
mv "$evidence" "$out" || die 1 "could not move the evidence to $out"
if [ "$status" = passed ]; then say "passed; evidence in $out"; exit 0; fi
say "FAILED; evidence in $out"; exit 1
