# lazysh host companion bootstrap. Reviewed like code: docs/architecture/adr-0003-host-side-companion-update.md
# The app runs it on the HOST as: sh -c '<this file>' lazysh-bootstrap VERSION SHA256 BYTES TARGET DIR
# VERSION, SHA256 and BYTES are the pin the app verified from the release metadata; nothing is downloaded on the phone.
# Output: newline-delimited JSON (stage events, then one result). Exit codes are the update contract of the ADR.
# Keep this file free of backslash pairs and quote-escapes: the login shell that receives it may be fish.
set -eu
umask 077
pid= work= lock= settled=0 latest=null cur_json=null prev_json=null
os=$(uname -s) arch=$(uname -m)

result() { # exit outcome kind detail message
  if [ "$1" -eq 0 ]; then err=null; else
    d=; [ -z "$4" ] || d=',"detail":"'$4'"'
    err='{"kind":"'$3'"'$d',"message":"'$5'","retryAfterSeconds":null}'
  fi
  printf '{"schemaVersion":1,"event":"result","action":"update","outcome":"%s","exitCode":%s,"error":%s,"current":%s,"previous":%s,"latest":%s}\n' "$2" "$1" "$err" "$cur_json" "$prev_json" "$latest"
}
finish() { settled=1; result "$@"; exit "$1"; }
stage() { printf '{"schemaVersion":1,"event":"stage","stage":"%s"}\n' "$1"; }
cleanup() {
  rc=$?
  trap - EXIT
  [ -z "$pid" ] || kill "$pid" 2>/dev/null || true
  [ -z "$work" ] || rm -rf "$work"
  [ -z "$lock" ] || rmdir "$lock" 2>/dev/null || true
  [ "$settled" -eq 1 ] || result "$rc" failed internal '' 'Unexpected failure'
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 141' PIPE

# Every argument is validated before it is used; anything else is a usage error.
usage() { finish 2 failed usage '' 'Invalid bootstrap arguments'; }
valid_version() {
  case $1 in ''|*[!0-9.]*|.*|*.|*..*) return 1;; esac
  oifs=$IFS; IFS=.; set -- $1; IFS=$oifs
  [ "$#" -eq 3 ] || return 1
  for part in "$1" "$2" "$3"; do
    case $part in 0|[1-9]*) [ "${#part}" -le 9 ] || return 1;; *) return 1;; esac
  done
}
[ "$#" -eq 5 ] || usage
version=$1 sha=$2 bytes=$3 target=$4 dir=$5
valid_version "$version" || usage
case $sha in *[!0-9a-f]*) usage;; esac
[ "${#sha}" -eq 64 ] || usage
case $bytes in ''|*[!0-9]*|0*) usage;; esac
[ "${#bytes}" -le 8 ] && [ "$bytes" -le 67108864 ] || usage
case $target in linux-agent-x64|linux-agent-arm64|macos-agent-x64|macos-agent-arm64) ;; *) usage;; esac
case $dir in /*/lazysh/companion) ;; *) usage;; esac
case $dir in *[[:cntrl:]]*) usage;; esac
case $dir/ in */../*|*/./*|*//*) usage;; esac
latest='{"version":"'$version'","target":"'$target'","bytes":'$bytes',"sha256":"'$sha'"}'
agent=$dir/lazysh-agent

unsafe() { finish 27 failed unsafeInstallLocation '' 'The managed companion location is not usable'; }
case $os/$arch/$target in
  Linux/x86_64/linux-agent-x64|Linux/aarch64/linux-agent-arm64|Linux/arm64/linux-agent-arm64) ;;
  Darwin/x86_64/macos-agent-x64|Darwin/arm64/macos-agent-arm64) ;;
  *) unsafe;;
esac
uid=$(id -u)
owner_mode() { if [ "$os" = Linux ]; then stat -c '%u %a' "$1"; else stat -f '%u %Lp' "$1"; fi; }

# The managed namespace: created private when absent, then held to the rules of the app's executable resolver.
[ -e "$dir" ] || mkdir -p "$dir" || unsafe
r=$dir
while [ "$r" != / ] && [ -n "$r" ]; do
  [ ! -L "$r" ] || unsafe
  if [ -e "$r" ]; then
    [ -d "$r" ] && [ -x "$r" ] || unsafe
    set -- $(owner_mode "$r") || unsafe
    [ "$#" -eq 2 ] || unsafe
    case $1 in ''|*[!0-9]*) unsafe;; esac
    case $2 in ''|*[!0-7]*) unsafe;; esac
    [ "$1" = 0 ] || [ "$1" = "$uid" ] || unsafe
    if [ "$((0$2 & 022))" -ne 0 ]; then
      [ "$1" = 0 ] && [ "$((0$2 & 01000))" -ne 0 ] || unsafe
    fi
  fi
  r=${r%/*}
done
if [ -e "$agent" ] || [ -L "$agent" ]; then
  [ -f "$agent" ] && [ ! -L "$agent" ] || unsafe
fi

# Another bootstrap on this host waits out a ten minute stale rule.
if ! mkdir "$dir/.lazysh-bootstrap.lock" 2>/dev/null; then
  if [ -n "$(find "$dir/.lazysh-bootstrap.lock" -prune -mmin +10 2>/dev/null)" ]; then
    rmdir "$dir/.lazysh-bootstrap.lock" 2>/dev/null || true
    mkdir "$dir/.lazysh-bootstrap.lock" 2>/dev/null || finish 26 failed busy '' 'Another update is running on this host'
  else
    finish 26 failed busy '' 'Another update is running on this host'
  fi
fi
lock=$dir/.lazysh-bootstrap.lock
# This run holds the lock, so any earlier staging directory is residue of a run that was killed.
find "$dir" -maxdepth 1 -type d -name '.update.*' -exec rm -rf {} + 2>/dev/null || true
work=$(mktemp -d "$dir/.update.XXXXXX") || unsafe
asset=$work/asset

# Wait for a background job with a time limit, calling "$3" once a second. The helper polls a sentinel file and
# ends by itself when the job does: kill -0 would keep succeeding on an unreaped job in dash, and a helper
# that sleeps for the whole limit would outlive this script and hold the SSH channel open.
await() { # pid seconds [reporter]
  rm -f "$work/finished"
  (
    t=0
    while [ ! -f "$work/finished" ]; do
      [ -z "${3-}" ] || [ $((t % 10)) -ne 0 ] || "$3"
      t=$((t + 1))
      [ "$t" -le $(($2 * 10)) ] || { kill "$1" 2>/dev/null || true; break; }
      sleep 0.1
    done
  ) &
  aw=$!
  ar=0; wait "$1" || ar=$?
  : >"$work/finished"
  wait "$aw" || true
  return "$ar"
}
# Run a command with a time limit and a named input file; the status is the command's own.
limited() { # seconds input command...
  secs=$1 input=$2; shift 2
  "$@" <"$input" &
  await "$!" "$secs"
}

# A newer installed version is never replaced, and the same version needs no download.
newer() { # is $1 strictly newer than $2
  oifs=$IFS; IFS=.; set -- $1 $2; IFS=$oifs
  [ "$1" -gt "$4" ] && return 0
  [ "$1" -lt "$4" ] && return 1
  [ "$2" -gt "$5" ] && return 0
  [ "$2" -lt "$5" ] && return 1
  [ "$3" -gt "$6" ]
}
installed=
if [ -f "$agent" ]; then
  limited 20 /dev/null "$agent" --version >"$work/installed" 2>/dev/null || true
  installed=$(cat "$work/installed")
  case $installed in "lazysh-agent "*) installed=${installed#lazysh-agent };; *) installed=;; esac
  valid_version "$installed" || installed=
fi
if [ -n "$installed" ]; then
  cur_json='{"version":"'$installed'","managed":true}'
  if [ "$installed" = "$version" ]; then finish 0 upToDate '' '' ''; fi
  ! newer "$installed" "$version" || finish 23 failed downgradeRefused '' 'The host has a newer companion'
fi

# A host without a downloader or a SHA-256 tool is told so before anything is fetched. BusyBox wget is refused: it may not check certificates.
if command -v curl >/dev/null 2>&1; then tool=curl
elif command -v wget >/dev/null 2>&1 && wget --version 2>&1 | head -n 1 | grep -q 'GNU Wget'; then tool=wget
else finish 30 failed hostToolMissing noDownloader 'The host has no curl or GNU wget'; fi
if command -v sha256sum >/dev/null 2>&1; then digest='sha256sum'
elif command -v shasum >/dev/null 2>&1; then digest='shasum -a 256'
else finish 30 failed hostToolMissing noDigestTool 'The host has no SHA-256 tool'; fi

# Download on this host, capped by ulimit, the declared size and a total time.
stage downloading
url=https://github.com/mihazs/lazysh/releases/download/v$version/lazysh-$version-$target.bin
blocks=$((bytes / 512 + 8))
(
  ulimit -f "$blocks" || exit 99
  if [ "$tool" = curl ]; then
    exec curl -q --silent --fail --location --proto '=https' --proto-redir '=https' --tlsv1.2 --max-redirs 3 \
      --max-filesize "$bytes" --connect-timeout 20 --max-time 240 -o "$asset" "$url"
  fi
  exec wget --quiet --https-only --check-certificate --secure-protocol=TLSv1_2 --max-redirect=3 \
    --tries=1 --timeout=60 -O "$asset" "$url"
) >/dev/null 2>&1 </dev/null &
pid=$!
progress() {
  size=0; [ ! -f "$asset" ] || size=$(( $(wc -c <"$asset") ))
  printf '{"schemaVersion":1,"event":"stage","stage":"downloading","bytes":%s,"total":%s}\n' "$size" "$bytes"
}
rc=0; await "$pid" 240 progress || rc=$?
pid=
# wget reports its own codes: fold them into the curl classes below.
if [ "$tool" = wget ]; then
  case $rc in 0|143|153) ;; 5) rc=60;; 4) rc=7;; *) rc=99;; esac
fi
case $rc in
  0) ;;
  63|153) finish 22 failed verificationFailed sizeMismatch 'The download is larger than the release declares';;
  1|47) finish 22 failed verificationFailed redirectRefused 'The download was redirected somewhere not allowed';;
  35|51|53|54|58|59|60|64|66|77|80|82|83|90|91|98) finish 20 failed networkUnavailable tls 'The host could not verify the release server';;
  6) finish 20 failed networkUnavailable dns 'The host could not download the release';;
  7) finish 20 failed networkUnavailable connect 'The host could not download the release';;
  28|143) finish 20 failed networkUnavailable timeout 'The host could not download the release';;
  22) finish 20 failed networkUnavailable http 'The host could not download the release';;
  *) finish 20 failed networkUnavailable '' 'The host could not download the release';;
esac

# Nothing runs, and nothing becomes executable, before the size and digest match the pin.
stage verifying
[ -f "$asset" ] && [ ! -L "$asset" ] || finish 22 failed verificationFailed sizeMismatch 'The download is not the release file'
[ "$(( $(wc -c <"$asset") ))" -eq "$bytes" ] || finish 22 failed verificationFailed sizeMismatch 'The download size does not match the release'
actual=$($digest "$asset")
actual=${actual%% *}
[ "$actual" = "$sha" ] || finish 22 failed verificationFailed digestMismatch 'The download does not match the release digest'
chmod 700 "$asset"

# The staged file must prove itself in a cleared environment before it can replace anything.
stage selfTesting
st=$work/selftest
mkdir "$st"
printf '%s' '{"schemaVersion":1,"sessionId":"lazysh-selftest","agent":"lazysh-selftest","project":"/lazysh-selftest","state":"done","summary":"selftest"}' >"$st/event.json"
selftest() { cd "$st" && exec env -i PATH=/usr/bin:/bin LAZYSH_STATE_DIR="$st/state" "$asset" "$@"; }
fail24() { finish 24 failed selfTestFailed '' 'The downloaded companion failed its self test'; }
limited 20 /dev/null selftest --version >"$st/version" 2>/dev/null || fail24
[ "$(cat "$st/version")" = "lazysh-agent $version" ] || fail24
limited 20 "$st/event.json" selftest ingest --agent generic >/dev/null 2>&1 || fail24
limited 20 /dev/null selftest snapshot --limit 1 >"$st/snapshot" 2>/dev/null || fail24
grep -q lazysh-selftest "$st/snapshot" || fail24

# Replace atomically in the managed directory: keep the previous binary, then rename the new one over the current.
stage replacing
if [ -f "$agent" ]; then
  [ -z "$installed" ] || prev_json='{"version":"'$installed'"}'
  cp -p "$agent" "$work/previous"
  mv -f "$work/previous" "$agent.previous"
fi
mv -f "$asset" "$agent"

stage checkingInstalled
back() { # restore the previous binary; 29 when even that failed
  if [ -f "$agent.previous" ]; then mv -f "$agent.previous" "$agent" || finish 29 uncertain uncertain '' 'The update could not be confirmed'
  else rm -f "$agent"; fi
  finish 25 failed rolledBack '' 'The new companion failed and the previous one was restored'
}
limited 20 /dev/null "$agent" --version >"$work/after" 2>/dev/null || back
[ "$(cat "$work/after")" = "lazysh-agent $version" ] || back
set -- $(owner_mode "$agent") || back
[ "$1" = "$uid" ] && [ "$2" = 700 ] || back
cur_json='{"version":"'$version'","managed":true}'
finish 0 updated '' '' ''
