# lazysh managed Herdr: explicit install and removal on the HOST. Reviewed like code: docs/herdr-managed-install.md
# The app runs it as: sh -c '<this file>' lazysh-managed-herdr ACTION ARGUMENTS
#   inspect DIR TARGET SHA256 BYTES STAGED         print the plan; change nothing
#   install DIR TARGET SHA256 BYTES STAGED PLAN    publish exactly that plan or fail
#   remove  DIR                                    delete the managed binary and nothing else
# DIR is the fixed managed directory (.../lazysh/herdr); the binary is DIR/lazysh-herdr. STAGED is the file the app uploaded
# over SFTP and pinned from the verified release. This file never reads, writes, signals or restarts the system herdr, its
# configuration, its servers or its sessions: it only ever touches DIR/lazysh-herdr and its own staging inside DIR.
# Output: one JSON line. Keep this file free of backslash pairs and quote-escapes: the login shell that receives it may be fish.
set -eu
umask 077
action=${1-} child= scratch= held= reported=0 state= ex_sha= ex_bytes= plan=

say() { printf '{"schemaVersion":1,"action":"%s",%s}\n' "$action" "$1"; }
finish() { reported=1; say "$2"; exit "$1"; }
fail() { finish "$1" '"outcome":"failed","exitCode":'"$1"',"error":{"kind":"'"$2"'"}'; }
cleanup() {
  rc=$?
  trap - EXIT
  [ -z "$child" ] || kill "$child" 2>/dev/null || true
  [ -z "$scratch" ] || rm -rf "$scratch"
  [ -z "$held" ] || rmdir "$held" 2>/dev/null || true
  [ "$reported" -eq 1 ] || say '"outcome":"failed","exitCode":'"$rc"',"error":{"kind":"internal"}'
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 141' PIPE

# Every argument is validated before it is used; anything else is a usage error.
usage() { fail 2 usage; }
case $action in
  inspect) [ "$#" -eq 6 ] || usage;;
  install) [ "$#" -eq 7 ] || usage;;
  remove) [ "$#" -eq 2 ] || usage;;
  *) action=unknown; usage;;
esac
dir=$2
case $dir in /*/lazysh/herdr) ;; *) usage;; esac
case $dir in *[[:cntrl:]]*) usage;; esac
case $dir/ in */../*|*/./*|*//*) usage;; esac
dest=$dir/lazysh-herdr
if [ "$action" != remove ]; then
  target=$3 sha=$4 bytes=$5 staged=$6
  case $target in linux-herdr-x64|linux-herdr-arm64|macos-herdr-x64|macos-herdr-arm64) ;; *) usage;; esac
  case $sha in *[!0-9a-f]*) usage;; esac
  [ "${#sha}" -eq 64 ] || usage
  case $bytes in ''|*[!0-9]*|0*) usage;; esac
  [ "${#bytes}" -le 8 ] && [ "$bytes" -le 67108864 ] || usage
  case $staged in /*/.lazysh-install-*/lazysh-herdr) ;; *) usage;; esac
  case $staged in *[[:cntrl:]]*) usage;; esac
  case $staged/ in */../*|*/./*|*//*) usage;; esac
fi
if [ "$action" = install ]; then
  expected=$7
  case $expected in *[!0-9a-f]*) usage;; esac
  [ "${#expected}" -eq 64 ] || usage
fi

os=$(uname -s) arch=$(uname -m) uid=$(id -u)
# The target is a closed choice and must be this host's own platform.
case $action in remove) case $os in Linux|Darwin) ;; *) fail 3 unsupportedHost;; esac;; *)
  case $os/$arch/$target in
    Linux/x86_64/linux-herdr-x64|Linux/aarch64/linux-herdr-arm64|Linux/arm64/linux-herdr-arm64) ;;
    Darwin/x86_64/macos-herdr-x64|Darwin/arm64/macos-herdr-arm64) ;;
    *) fail 3 unsupportedHost;;
  esac;;
esac
if command -v sha256sum >/dev/null 2>&1; then digest=sha256sum
elif command -v shasum >/dev/null 2>&1; then digest='shasum -a 256'
else fail 10 hostToolMissing; fi

fields() { # uid, mode, link count and size of one path
  if [ "$os" = Linux ]; then stat -c '%u %a %h %s' "$1"; else stat -f '%u %Lp %l %z' "$1"; fi
}
hash_of() { out=$($digest "$1") && printf '%s' "${out%% *}"; }
# Every existing ancestor of the path is a real directory that only this user or root can write to.
safe_chain() {
  p=$1
  while [ -n "$p" ] && [ "$p" != / ]; do
    [ ! -L "$p" ] || return 1
    if [ -e "$p" ]; then
      [ -d "$p" ] && [ -x "$p" ] || return 1
      set -- $(fields "$p")
      [ "$#" -eq 4 ] || return 1
      case $1 in ''|*[!0-9]*) return 1;; esac
      case $2 in ''|*[!0-7]*) return 1;; esac
      [ "$1" = 0 ] || [ "$1" = "$uid" ] || return 1
      if [ "$((0$2 & 022))" -ne 0 ]; then
        [ "$1" = 0 ] && [ "$((0$2 & 01000))" -ne 0 ] || return 1
      fi
    fi
    p=${p%/*}
  done
}
# The managed directory itself belongs to this user and is closed to everyone else.
own_dir() { set -- $(fields "$dir") && [ "$1" = "$uid" ] && [ "$((0$2 & 077))" -eq 0 ]; }
# The destination is either absent or this user's private regular file: anything else is unsafe and never replaced.
existing() {
  state=missing ex_sha= ex_bytes=
  [ ! -L "$dest" ] || return 1
  [ -e "$dest" ] || return 0
  [ -f "$dest" ] || return 1
  set -- $(fields "$dest")
  [ "$#" -eq 4 ] && [ "$1" = "$uid" ] && [ "$2" = 700 ] && [ "$3" = 1 ] || return 1
  ex_bytes=$4
  ex_sha=$(hash_of "$dest") || return 1
  state=present
}
existing_json() {
  if [ "$state" = present ]; then printf '{"state":"present","sha256":"%s","bytes":%s}' "$ex_sha" "$ex_bytes"
  else printf '{"state":"missing"}'; fi
}
# The plan is the hash of everything an install depends on: where, which target, which bytes, and what is there now.
plan_now() {
  p=$(printf '%s\n' lazysh-managed-herdr-plan-v1 "$dest" "$target" "$sha" "$bytes" "$state $ex_sha $ex_bytes" | $digest) || return 1
  plan=${p%% *}
}
# A private regular file of exactly the pinned size and digest.
pinned() { # path mode
  [ ! -L "$1" ] && [ -f "$1" ] || return 1
  [ "$(fields "$1")" = "$uid $2 1 $bytes" ] || return 1
  [ "$(hash_of "$1")" = "$sha" ]
}
# The first bytes of the file name this target's executable format and CPU: the first 20 bytes of an ELF or the first 8 of a Mach-O.
architecture() {
  h=$(od -An -v -tx1 -N20 "$1" | tr -d '[:space:]') || return 1
  case $target:$h in
    linux-herdr-x64:7f454c460201????????????????????????3e00*|linux-herdr-arm64:7f454c460201????????????????????????b700*) ;;
    macos-herdr-x64:cffaedfe07000001*|macos-herdr-arm64:cffaedfe0c000001*) ;;
    *) return 1;;
  esac
}
take_lock() {
  if ! mkdir "$dir/.lock" 2>/dev/null; then
    # A run killed outright leaves its lock behind: it is stale after ten minutes.
    [ -n "$(find "$dir/.lock" -prune -mmin +10 2>/dev/null)" ] && rmdir "$dir/.lock" 2>/dev/null || true
    mkdir "$dir/.lock" 2>/dev/null || fail 8 hostBusy
  fi
  held=$dir/.lock
}

safe_chain "$dir" || fail 4 unsafeLocation
if [ -e "$dir" ]; then own_dir || fail 4 unsafeLocation; fi

if [ "$action" = remove ]; then
  [ -d "$dir" ] || finish 0 '"outcome":"absent"'
  take_lock
  existing || fail 4 unsafeLocation
  [ "$state" = present ] || finish 0 '"outcome":"absent"'
  rm -f "$dest"
  finish 0 '"outcome":"removed"'
fi

# What was staged is the pinned file, owned by this user, in a private directory the app created, for this CPU.
set -- $(fields "${staged%/*}")
[ ! -L "${staged%/*}" ] && [ "$#" -eq 4 ] && [ "$1" = "$uid" ] && [ "$2" = 700 ] || fail 5 stagedMismatch
pinned "$staged" 600 || fail 5 stagedMismatch
architecture "$staged" || fail 6 architectureMismatch
existing || fail 4 unsafeLocation
plan_now || fail 10 hostToolMissing
if [ "$action" = inspect ]; then
  finish 0 '"outcome":"planned","plan":"'"$plan"'","existing":'"$(existing_json)"
fi
# The host must still look exactly as it did when the plan was made.
[ "$plan" = "$expected" ] || fail 7 stalePlan
if [ "$state" = present ] && [ "$ex_sha" = "$sha" ]; then
  finish 0 '"outcome":"reused","plan":"'"$plan"'","existing":'"$(existing_json)"
fi

mkdir -p "$dir"
safe_chain "$dir" && own_dir || fail 4 unsafeLocation
take_lock
# This run holds the lock, so any earlier staging directory is residue of a run that was killed.
find "$dir" -maxdepth 1 -type d -name '.work.*' -exec rm -rf {} + 2>/dev/null || true
existing || fail 4 unsafeLocation
plan_now || fail 10 hostToolMissing
[ "$plan" = "$expected" ] || fail 7 stalePlan

scratch=$(mktemp -d "$dir/.work.XXXXXX") || fail 4 unsafeLocation
cp "$staged" "$scratch/new" || fail 5 stagedMismatch
chmod 700 "$scratch/new"
# The copy about to be published is checked again: same bytes, same CPU, and it runs on this host.
pinned "$scratch/new" 700 || fail 5 stagedMismatch
architecture "$scratch/new" || fail 6 architectureMismatch
env -i PATH=/usr/bin:/bin HOME="$scratch" "$scratch/new" --version >"$scratch/version" 2>&1 </dev/null &
child=$!
( t=0; while [ ! -f "$scratch/finished" ] && [ -d "$scratch" ] && [ "$t" -lt 200 ]; do sleep 0.1; t=$((t + 1)); done
  [ -f "$scratch/finished" ] || [ ! -d "$scratch" ] || kill "$child" ) >/dev/null 2>&1 </dev/null &
watchdog=$!
rc=0; wait "$child" || rc=$?
child=
: >"$scratch/finished"
wait "$watchdog" || true
[ "$rc" -eq 0 ] || fail 9 selfTestFailed

# One rename inside the managed directory: the destination is the old file or the new one, never a partial file.
mv -f "$scratch/new" "$dest" || fail 11 installedMismatch
existing && [ "$state" = present ] && [ "$ex_sha" = "$sha" ] && [ "$ex_bytes" = "$bytes" ] || fail 11 installedMismatch
finish 0 '"outcome":"installed","plan":"'"$plan"'","existing":'"$(existing_json)"
